import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/**
 * Apply SQL migrations in `server/migrations/` in lexical order against
 * DATABASE_URL. By default runs the standard (1536) variant; set
 * EMBED_PROVIDER=local to run the `*.local.sql` (halfvec(384)) variants instead.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  // src/scripts -> ../../migrations ; dist/scripts -> ../../migrations
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
  const useLocal = (process.env.EMBED_PROVIDER ?? "openai") === "local";

  const all = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  // Pick the right variant per migration: when local, prefer `*.local.sql` and
  // fall back to the base file only if no local variant exists; otherwise skip
  // all `*.local.sql` files.
  const files = all.filter((f) => {
    const isLocal = f.includes(".local.");
    if (useLocal) {
      if (isLocal) return true;
      const localTwin = f.replace(/\.sql$/, ".local.sql");
      return !all.includes(localTwin);
    }
    return !isLocal;
  });

  if (files.length === 0) {
    console.log(`No migrations found in ${migrationsDir}`);
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      process.stdout.write(`Applying ${file} ... `);
      await client.query(sql);
      console.log("ok");
    }
    console.log(`Applied ${files.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("migrate failed:", err);
  process.exit(1);
});
