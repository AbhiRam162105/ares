import { createHash, randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { HttpBindings } from "@hono/node-server";
import type { Pool } from "pg";
import type { Config, Ctx, Workspace } from "../types.js";

/**
 * Hono environment shared across the HTTP layer.
 * `db` and `config` are injected once per request by the app-level middleware;
 * `ctx` is populated by {@link apiKeyAuth} after a key resolves to a workspace.
 */
export type AppEnv = {
  Bindings: HttpBindings;
  Variables: {
    db: Pool;
    config: Config;
    ctx: Ctx;
  };
};

const KEY_PREFIX = "ares_sk_";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** sha256(token) as lowercase hex — the value stored in `api_keys.key_hash`. */
export function hashKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a fresh `ares_sk_<32 base62>` API token. The raw token is shown only once. */
export function generateApiKey(): string {
  const bytes = randomBytes(32);
  let body = "";
  for (let i = 0; i < bytes.length; i++) {
    body += BASE62[bytes[i] % 62];
  }
  return KEY_PREFIX + body;
}

const BEARER_RE = /^Bearer\s+(ares_sk_[0-9A-Za-z]+)\s*$/;

/**
 * Resolve a Bearer API key to a workspace and attach a {@link Ctx} to the request.
 * Expects `db` and `config` to already be set on the context (see http/app.ts).
 * Returns 401 on a missing/unknown/revoked key. Updates `last_used_at` fire-and-forget.
 */
export const apiKeyAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const match = header.match(BEARER_RE);
  if (!match) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const token = match[1];
  const keyHash = hashKey(token);

  const db = c.get("db");
  const config = c.get("config");

  const result = await db.query(
    `SELECT k.id           AS key_id,
            k.name         AS key_name,
            w.id           AS workspace_id,
            w.name         AS workspace_name,
            w.embed_model  AS embed_model,
            w.embed_dim    AS embed_dim
     FROM api_keys k
     JOIN workspaces w ON w.id = k.workspace_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [keyHash],
  );

  if (result.rowCount === 0) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const row = result.rows[0];
  const workspace: Workspace = {
    id: row.workspace_id,
    name: row.workspace_name,
    embed_model: row.embed_model,
    embed_dim: row.embed_dim,
  };
  const ctx: Ctx = {
    db,
    workspace,
    config,
    actor: row.key_name ?? row.key_id,
  };
  c.set("ctx", ctx);

  // Fire-and-forget: never block the request on the audit-ish timestamp write.
  void db
    .query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.key_id])
    .catch(() => {});

  await next();
};
