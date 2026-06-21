// Simulates exactly what Cursor does: spawn the ares-mcp stdio binary with the
// .cursor/mcp.json env, then list tools and call them over the MCP protocol.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const STDIO = new URL("./dist/mcp/stdio.js", import.meta.url).pathname;

const transport = new StdioClientTransport({
  command: "node",
  args: [STDIO],
  env: {
    ...process.env,
    ARES_API_URL: process.env.ARES_API_URL ?? "http://localhost:8787",
    ARES_API_KEY: process.env.ARES_API_KEY ?? "",
  },
});

const client = new Client({ name: "ares-smoke", version: "0.0.0" }, { capabilities: {} });

function textOf(res) {
  return (res.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

await client.connect(transport);
console.log("connected to ares-mcp (stdio)\n");

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "), "\n");

console.log("== recall_decisions(query='string formatting', repo='electron/electron') ==");
const recall = await client.callTool({
  name: "recall_decisions",
  arguments: { query: "string formatting and function declarations", repo: "electron/electron", limit: 4 },
});
console.log(textOf(recall), "\n");

console.log("== check_conflict(snippet uses + concat, repo='electron/electron') ==");
const check = await client.callTool({
  name: "check_conflict",
  arguments: {
    repo: "electron/electron",
    intent: "building a string by concatenating values with the + operator",
    snippet: 'const url = "/users/" + id + "/" + name;',
  },
});
console.log(textOf(check), "\n");

await client.close();
console.log("OK — MCP stdio path works end-to-end");
process.exit(0);
