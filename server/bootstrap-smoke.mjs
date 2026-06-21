// Simulates Cursor's first run in a fresh repo: spawn ares-mcp (proxy → server),
// call ensure_repo_memory (auto-bootstrap), then recall to prove it's populated.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const STDIO = new URL("./dist/mcp/stdio.js", import.meta.url).pathname;
const REPO = process.argv[2] ?? "honojs/hono";

const transport = new StdioClientTransport({
  command: "node",
  args: [STDIO],
  env: {
    ...process.env,
    ARES_API_URL: process.env.ARES_API_URL ?? "http://localhost:8787",
    ARES_API_KEY: process.env.ARES_API_KEY ?? "",
  },
});
const client = new Client({ name: "bootstrap-smoke", version: "0" }, { capabilities: {} });
const textOf = (r) => (r.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");

await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("TOOLS:", tools.join(", "));
console.log("has ensure_repo_memory:", tools.includes("ensure_repo_memory"), "\n");

console.log(`== ensure_repo_memory(${REPO}) — first run auto-bootstrap ==`);
const t0 = Date.now();
const boot = await client.callTool({ name: "ensure_repo_memory", arguments: { repo: REPO } });
console.log(textOf(boot), `(${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);

console.log(`== recall_decisions on freshly-bootstrapped ${REPO} ==`);
const recall = await client.callTool({
  name: "recall_decisions",
  arguments: { query: "conventions for this codebase", repo: REPO, limit: 4 },
});
console.log(textOf(recall), "\n");

await client.close();
process.exit(0);
