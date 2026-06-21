import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { makePool } from "./db.js";
import { buildApp } from "./http/app.js";

const config = loadConfig();
const pool = await makePool(config);
const app = buildApp(pool, config);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `ARES server v2.0.0 listening on http://localhost:${info.port}` +
      ` (embed=${config.embedProvider}/${config.embedModel}, llm=${config.llmProvider}/${config.llmModel})`,
  );
  console.log(`  REST: http://localhost:${info.port}/v1/*`);
  console.log(`  MCP : http://localhost:${info.port}/mcp (Streamable HTTP, stateless)`);
});
