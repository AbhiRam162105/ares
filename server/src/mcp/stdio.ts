#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Ctx, Workspace } from "../types.js";
import { loadConfig } from "../config.js";
import { makePool } from "../db.js";
import { hashKey } from "../http/auth.js";
import { buildMcpServer } from "./server.js";
import {
  formatDecisionsForAgent,
  formatConflictsForAgent,
} from "../scripts/format.js";

/**
 * stdio entry point (bin: `ares-mcp`). Any IDE/agent can spawn this.
 *
 * Two modes, selected by env:
 *   - Proxy (ARES_API_URL set): tools forward to a hosted ARES over REST. The
 *     shared team corpus; no local DB or provider keys needed.
 *   - Direct (no ARES_API_URL): talk straight to Postgres + providers. Resolves
 *     a workspace from ARES_API_KEY, else falls back to the first workspace.
 */

async function buildDirectServer(): Promise<McpServer> {
  const config = loadConfig();
  const pool = await makePool(config);

  let row: { id: string; name: string; embed_model: string; embed_dim: number } | undefined;

  if (process.env.ARES_API_KEY) {
    const res = await pool.query(
      `SELECT w.id, w.name, w.embed_model, w.embed_dim
       FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [hashKey(process.env.ARES_API_KEY)],
    );
    row = res.rows[0];
  }
  if (!row) {
    const res = await pool.query(
      `SELECT id, name, embed_model, embed_dim FROM workspaces ORDER BY created_at ASC LIMIT 1`,
    );
    row = res.rows[0];
  }
  if (!row) {
    throw new Error(
      "ares-mcp (direct mode): no workspace found. Run `npm run seed` first or set ARES_API_URL for proxy mode.",
    );
  }

  const workspace: Workspace = {
    id: row.id,
    name: row.name,
    embed_model: row.embed_model,
    embed_dim: row.embed_dim,
  };
  const ctx: Ctx = { db: pool, workspace, config, actor: "mcp-stdio" };
  return buildMcpServer(ctx);
}

function renderDecisions(decisions: any[]): string {
  if (!decisions || decisions.length === 0) return "No decisions found.";
  return decisions
    .map((d) => {
      const scope = d.repo_id ? ` (${d.repo_id})` : "";
      const why = d.rationale ? ` — ${d.rationale}` : "";
      return `- [${d.id}] (${d.status})${scope} ${d.statement}${why}`;
    })
    .join("\n");
}

function buildProxyServer(apiUrl: string, apiKey: string): McpServer {
  const base = apiUrl.replace(/\/+$/, "");

  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<any> {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`ARES ${method} ${path} -> ${res.status} ${res.statusText}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  const server = new McpServer({ name: "ares", version: "2.0.0" });

  server.registerTool(
    "ensure_repo_memory",
    {
      title: "Bootstrap repo decision memory",
      description:
        "Call this ONCE at the start of working in a repo, BEFORE your first recall_decisions. Returns immediately. If ARES has no decisions for this repo yet, it kicks off a BACKGROUND mine from the repo's docs and PR review comments (code-anchored) — recall improves over the next ~30-60s and a markdown summary is written. Idempotent: instant no-op if already populated. Pass repo as 'owner/repo' (lowercase). Set deep:true for a thorough mine.",
      inputSchema: { repo: z.string(), deep: z.boolean().optional() },
    },
    async ({ repo, deep }) => {
      const r = await call("POST", "/v1/bootstrap", { repo, deep });
      const msg =
        r.status === "ready"
          ? `Repo "${r.repo_id}" memory is ready (${r.existing} decisions). Proceed.`
          : r.started
            ? `Started bootstrapping "${r.repo_id}" in the background (~30-60s). You can proceed; recall will improve as decisions land, and a summary doc is being written.`
            : `Bootstrap for "${r.repo_id}" already in progress. Proceed; recall improves as it completes.`;
      return { content: [{ type: "text", text: msg }], structuredContent: r };
    },
  );

  server.registerTool(
    "get_repo_summary",
    {
      title: "Get repo conventions summary",
      description:
        "Return the markdown digest of a repo's mined conventions (themed groups of decisions). Pass repo as 'owner/repo'.",
      inputSchema: { repo: z.string() },
    },
    async ({ repo }) => {
      const r = await call("GET", `/v1/repos/summary?repo=${encodeURIComponent(repo)}`).catch(
        () => null,
      );
      return {
        content: [{ type: "text", text: r?.markdown ?? `No summary yet for ${repo}.` }],
        structuredContent: { repo_id: repo.toLowerCase(), markdown: r?.markdown ?? null },
      };
    },
  );

  server.registerTool(
    "recall_decisions",
    {
      title: "Recall team decisions",
      description:
        "BEFORE writing code, search the team's past engineering decisions for this repo by meaning. Call this whenever you are about to implement something that might have an established convention (auth, caching, IDs, retries, error handling, dependencies). Cite results as [decision_id].",
      inputSchema: {
        query: z.string(),
        repo: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(5),
      },
    },
    async ({ query, repo, limit }) => {
      const { decisions } = await call("POST", "/v1/recall", { query, repo, limit });
      return {
        content: [{ type: "text", text: formatDecisionsForAgent(decisions) }],
        structuredContent: { decisions },
      };
    },
  );

  server.registerTool(
    "check_conflict",
    {
      title: "Check code against memory",
      description:
        "AFTER drafting code, check whether it conflicts with a past decision. Returns the violated decision(s) with reasoning so you can self-correct.",
      inputSchema: {
        snippet: z.string().optional(),
        repo: z.string().optional(),
        intent: z.string().optional(),
      },
    },
    async ({ snippet, repo, intent }) => {
      const { conflicts } = await call("POST", "/v1/check", {
        snippet,
        repo_id: repo,
        intent,
      });
      return {
        content: [{ type: "text", text: formatConflictsForAgent(conflicts) }],
        structuredContent: { conflicts },
      };
    },
  );

  server.registerTool(
    "record_decision",
    {
      title: "Record a decision",
      description:
        "Persist a new engineering decision so future code (by any agent or human) respects it.",
      inputSchema: {
        statement: z.string(),
        rationale: z.string().optional(),
        repo: z.string().optional(),
        scope_globs: z.array(z.string()).optional(),
        context_code: z.string().optional(),
        source_url: z.string().optional(),
        author: z.string().optional(),
      },
    },
    async ({ repo, ...rest }) => {
      const decision = await call("POST", "/v1/decisions", { ...rest, repo_id: repo });
      return {
        content: [{ type: "text", text: `Recorded decision ${decision.id}` }],
        structuredContent: { decision },
      };
    },
  );

  server.registerTool(
    "list_decisions",
    {
      title: "List decisions",
      description:
        "List the team's decisions, optionally filtered by repo and lifecycle status.",
      inputSchema: {
        repo: z.string().optional(),
        status: z.enum(["active", "superseded", "deprecated"]).optional(),
      },
    },
    async ({ repo, status }) => {
      const qs = new URLSearchParams();
      if (repo) qs.set("repo", repo);
      if (status) qs.set("status", status);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const { decisions } = await call("GET", `/v1/decisions${suffix}`);
      return {
        content: [{ type: "text", text: renderDecisions(decisions) }],
        structuredContent: { decisions },
      };
    },
  );

  server.registerTool(
    "get_decision",
    {
      title: "Get a decision",
      description: "Fetch a single decision by its id.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const decision = await call("GET", `/v1/decisions/${encodeURIComponent(id)}`).catch(
        () => null,
      );
      return {
        content: [
          {
            type: "text",
            text: decision
              ? renderDecisions([decision])
              : `No decision found for ${id}`,
          },
        ],
        structuredContent: { decision },
      };
    },
  );

  server.registerTool(
    "supersede_decision",
    {
      title: "Supersede a decision",
      description:
        "Replace an existing decision with an updated one. The old one is marked 'superseded'; the new one links back to it.",
      inputSchema: {
        id: z.string(),
        statement: z.string(),
        rationale: z.string().optional(),
        repo: z.string().optional(),
        scope_globs: z.array(z.string()).optional(),
        context_code: z.string().optional(),
        source_url: z.string().optional(),
        author: z.string().optional(),
      },
    },
    async ({ id, repo, ...rest }) => {
      const decision = await call(
        "POST",
        `/v1/decisions/${encodeURIComponent(id)}/supersede`,
        { ...rest, repo_id: repo },
      );
      return {
        content: [
          { type: "text", text: `Superseded ${id} with new decision ${decision.id}` },
        ],
        structuredContent: { decision },
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const apiUrl = process.env.ARES_API_URL;
  const server = apiUrl
    ? buildProxyServer(apiUrl, process.env.ARES_API_KEY ?? "")
    : await buildDirectServer();

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("ares-mcp failed to start:", err);
  process.exit(1);
});
