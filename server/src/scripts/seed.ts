import { loadConfig } from "../config.js";
import { makePool } from "../db.js";
import { generateApiKey, hashKey } from "../http/auth.js";
import { recordDecision, recallDecisions } from "../core/memory.js";
import type { Ctx, RecordInput, Workspace } from "../types.js";

const DEMO_REPO = "demo/demo";

const DEMO_DECISIONS: RecordInput[] = [
  {
    statement:
      "Never cache auth responses. Password resets must invalidate the cache.",
    rationale:
      "We got burned in Sep 2025 when Redis-cached tokens kept revoked users logged in.",
    author: "@sarah",
    repo_id: DEMO_REPO,
    source_url: "https://github.com/demo/demo/pull/42",
  },
  {
    statement: "Always use UUIDs for new tables, not auto-increment IDs.",
    rationale:
      "Auto-increment IDs leak record counts to the API and made our /users/42 endpoints enumerable.",
    author: "@raj",
    repo_id: DEMO_REPO,
    source_url: "https://github.com/demo/demo/pull/51",
  },
  {
    statement: "All retries must include exponential backoff with jitter.",
    rationale:
      "Without jitter, our retries DDoS'd the payment provider in Nov 2025.",
    author: "@kavya",
    repo_id: DEMO_REPO,
    source_url: "https://github.com/demo/demo/pull/63",
  },
];

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = await makePool(config);

  try {
    const wsRes = await pool.query(
      `INSERT INTO workspaces (name, embed_model, embed_dim)
       VALUES ($1, $2, $3)
       RETURNING id, name, embed_model, embed_dim`,
      ["Demo Workspace", config.embedModel, config.embedDim],
    );
    const workspace: Workspace = wsRes.rows[0];

    const token = generateApiKey();
    await pool.query(
      `INSERT INTO api_keys (workspace_id, name, key_hash, key_prefix)
       VALUES ($1, $2, $3, $4)`,
      [workspace.id, "seed-key", hashKey(token), token.slice(0, 12)],
    );

    console.log("─".repeat(64));
    console.log(`Workspace created: ${workspace.name} (${workspace.id})`);
    console.log("API key (shown ONCE — save it now):");
    console.log(`  ${token}`);
    console.log("─".repeat(64));

    const ctx: Ctx = { db: pool, workspace, config, actor: "seed" };

    for (const input of DEMO_DECISIONS) {
      const decision = await recordDecision(input, ctx);
      console.log(`Recorded ${decision.id}  ${decision.author}  ${decision.statement}`);
    }

    console.log("\nRecall smoke test — query: \"auth caching\"");
    const results = await recallDecisions("auth caching", { limit: 5 }, ctx);
    if (results.length === 0) {
      console.warn("  (no results — check embeddings/threshold/ef_search)");
    }
    for (const r of results) {
      console.log(`  [${r.similarity.toFixed(3)}] ${r.id}  ${r.statement}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
