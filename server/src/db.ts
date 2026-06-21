import { Pool } from "pg";
import pgvector from "pgvector/pg";
import type { Config } from "./types.js";

/**
 * Build the pg connection pool (PRD §6.1). On every new connection we register
 * pgvector's types (so halfvec/vector <-> number[] just work) and set the HNSW
 * query-time search width (§4.2).
 */
export async function makePool(config: Config): Promise<Pool> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  pool.on("connect", async (client) => {
    await pgvector.registerTypes(client);
    await client.query("SET hnsw.ef_search = 100");
  });
  return pool;
}
