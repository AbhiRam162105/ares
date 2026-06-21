import type { Hono } from "hono";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { AppEnv } from "./auth.js";
import { apiKeyAuth } from "./auth.js";
import { buildMcpServer } from "../mcp/server.js";

/**
 * Mount the MCP Streamable HTTP transport at `POST /mcp`, behind the same
 * API-key auth as REST. Runs STATELESS (sessionIdGenerator: undefined): a fresh
 * server + transport are built per request and torn down when the response ends.
 *
 * Bridges Hono's raw Node req/res (provided by @hono/node-server) into the
 * transport. The already-parsed JSON body is handed to handleRequest so the
 * consumed request stream is not re-read.
 */
export function mountMcp(app: Hono<AppEnv>): void {
  app.post("/mcp", apiKeyAuth, async (c) => {
    const ctx = c.get("ctx");
    const server = buildMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const { incoming, outgoing } = c.env;
    outgoing.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);

    const body = await c.req.json().catch(() => undefined);
    await transport.handleRequest(incoming, outgoing, body);

    return RESPONSE_ALREADY_SENT;
  });
}
