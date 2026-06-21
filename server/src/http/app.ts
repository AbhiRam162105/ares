import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import type { Pool } from "pg";
import type { Config } from "../types.js";
import type { AppEnv } from "./auth.js";
import { apiKeyAuth } from "./auth.js";
import { health, routes } from "./routes.js";
import { mountMcp } from "./mcp-http.js";

const STATIC_ORIGINS = ["https://github.com"];

function buildOriginChecker(config: Config) {
  const extra = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = new Set([...STATIC_ORIGINS, ...extra]);

  return (origin: string): string | null => {
    if (!origin) return origin;
    if (allowed.has(origin)) return origin;
    if (origin.startsWith("chrome-extension://")) return origin;
    return null;
  };
}

/** Construct the Hono app: CORS, per-request db/config injection, REST, and MCP. */
export function buildApp(pool: Pool, config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(
    "*",
    cors({
      origin: buildOriginChecker(config),
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    }),
  );

  // Inject shared per-request dependencies before anything else.
  app.use("*", async (c, next) => {
    c.set("db", pool);
    c.set("config", config);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json({ error: "invalid_request", details: err.issues }, 400);
    }
    console.error(err);
    return c.json({ error: "internal_error", message: (err as Error).message }, 500);
  });

  // Health is registered BEFORE the auth middleware so it stays public.
  app.route("/", health);

  // Everything else under /v1 requires a valid API key.
  app.use("/v1/*", apiKeyAuth);
  app.route("/", routes);

  // MCP Streamable HTTP (applies apiKeyAuth itself).
  mountMcp(app);

  return app;
}
