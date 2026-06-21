import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadConfig } from "../config.js";
import { makePool } from "../db.js";
import { hashKey } from "../http/auth.js";
import { extractDecisions } from "../core/extract.js";
import { recordDecision, recallDecisions } from "../core/memory.js";
import type { Ctx, Workspace } from "../types.js";

/**
 * Repo ingest: turn an existing repo's written signal (READMEs, CONTRIBUTING,
 * docs/, ADRs, decision records) into ARES decisions so a "random" repo is
 * useful immediately instead of empty.
 *
 * Two sources:
 *   --github owner/repo   fetch raw README.md + CONTRIBUTING.md (+ --files a.md,b.md),
 *                         unauthenticated via raw.githubusercontent.com
 *   --path <dir>          recursively scan a local clone for markdown docs
 *
 * Flags:
 *   --repo owner/repo     repo_id to store under (defaults to --github value or dir name)
 *   --files a.md,b.md     extra raw paths to fetch (github mode)
 *   --max-chunks N        cap chunks sent to the extractor (default 24)
 *   --max-decisions N     cap decisions recorded (default 40)
 *   --min-confidence X    keep candidates with confidence >= X (default 0.6)
 *   --dry-run             print what would be recorded; write nothing
 *
 * Examples:
 *   npm run ingest -- --github airbnb/javascript
 *   npm run ingest -- --path ../some-clone --repo acme/widgets
 */

type Doc = { name: string; text: string };

const RAW_BASE = "https://raw.githubusercontent.com";
const DEFAULT_GH_FILES = [
  "README.md",
  "readme.md",
  "CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  "CONVENTIONS.md",
  "STYLE.md",
  "docs/style-guide.md",
];

const DOC_PRIORITY = /(^|\/)(readme|contributing|conventions|style|guidelines?)\.md$/i;
const DOC_DIRS = /(^|\/)(docs?|adr|adrs|rfcs?|decisions?|architecture)(\/|$)/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", ".next"]);

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function fetchRaw(owner: string, repo: string, path: string): Promise<string | null> {
  for (const ref of ["HEAD", "main", "master"]) {
    const url = `${RAW_BASE}/${owner}/${repo}/${ref}/${path}`;
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch {
      /* try next ref */
    }
  }
  return null;
}

async function collectFromGithub(
  ownerRepo: string,
  extraFiles: string[],
): Promise<Doc[]> {
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`--github expects "owner/repo", got "${ownerRepo}"`);
  }
  const wanted = [...DEFAULT_GH_FILES, ...extraFiles];
  const docs: Doc[] = [];
  const seen = new Set<string>();
  for (const path of wanted) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const text = await fetchRaw(owner, repo, path);
    if (text && text.trim().length > 0) {
      docs.push({ name: path, text });
      console.log(`  fetched ${path} (${text.length} chars)`);
    }
  }
  return docs;
}

async function walkMarkdown(dir: string, root: string, acc: Doc[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walkMarkdown(full, root, acc);
    } else if (/\.(md|mdx)$/i.test(entry.name)) {
      const rel = relative(root, full);
      const text = await readFile(full, "utf8").catch(() => "");
      if (text.trim().length > 0) acc.push({ name: rel, text });
    }
  }
}

async function collectFromPath(dir: string): Promise<Doc[]> {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`--path "${dir}" is not a directory`);
  const acc: Doc[] = [];
  await walkMarkdown(dir, dir, acc);
  // Prioritize the docs most likely to encode decisions.
  acc.sort((a, b) => score(b.name) - score(a.name));
  return acc;
}

function score(name: string): number {
  let s = 0;
  if (DOC_PRIORITY.test(name)) s += 10;
  if (DOC_DIRS.test(name)) s += 5;
  return s;
}

/** Split markdown into ~1500-char chunks on blank-line boundaries. */
function chunk(text: string, target = 1500): string[] {
  const clean = text.replace(/```[\s\S]*?```/g, " "); // drop fenced code blocks
  const paras = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf.length + p.length + 2 > target && buf) {
      chunks.push(buf);
      buf = "";
    }
    buf += (buf ? "\n\n" : "") + p;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function resolveWorkspace(pool: Awaited<ReturnType<typeof makePool>>): Promise<Workspace> {
  if (process.env.ARES_API_KEY) {
    const res = await pool.query(
      `SELECT w.id, w.name, w.embed_model, w.embed_dim
       FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [hashKey(process.env.ARES_API_KEY)],
    );
    if (res.rows[0]) return res.rows[0];
  }
  const res = await pool.query(
    `SELECT id, name, embed_model, embed_dim FROM workspaces ORDER BY created_at ASC LIMIT 1`,
  );
  if (!res.rows[0]) {
    throw new Error("No workspace found. Run `npm run seed` first (or set ARES_API_KEY).");
  }
  return res.rows[0];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const github = typeof args.github === "string" ? args.github : undefined;
  const path = typeof args.path === "string" ? args.path : undefined;
  if (!github && !path) {
    throw new Error("Provide --github owner/repo OR --path <dir>");
  }

  const repoId = (
    (typeof args.repo === "string" && args.repo) ||
    github ||
    (path ? path.split("/").filter(Boolean).slice(-2).join("/") : "")
  ).toLowerCase();

  const extraFiles =
    typeof args.files === "string" ? args.files.split(",").map((f) => f.trim()).filter(Boolean) : [];
  const maxChunks = Number(args["max-chunks"] ?? 24);
  const maxDecisions = Number(args["max-decisions"] ?? 40);
  const minConfidence = Number(args["min-confidence"] ?? 0.6);
  const dryRun = args["dry-run"] === true;
  const sourceUrl = github ? `https://github.com/${github}` : undefined;

  console.log("─".repeat(64));
  console.log(`ARES ingest → repo_id "${repoId}"  ${dryRun ? "(DRY RUN)" : ""}`);
  console.log(`Source: ${github ? `github:${github}` : `path:${path}`}`);
  console.log("Collecting documents...");

  const docs = github
    ? await collectFromGithub(github, extraFiles)
    : await collectFromPath(path!);

  if (docs.length === 0) {
    console.log("No markdown documents found. Nothing to ingest.");
    return;
  }

  // Build chunk list across docs, capped.
  const chunks: Array<{ doc: string; text: string }> = [];
  for (const doc of docs) {
    for (const c of chunk(doc.text)) {
      chunks.push({ doc: doc.name, text: c });
      if (chunks.length >= maxChunks) break;
    }
    if (chunks.length >= maxChunks) break;
  }
  console.log(`Extracting decisions from ${chunks.length} chunk(s) across ${docs.length} doc(s)...`);

  const config = loadConfig();
  const pool = await makePool(config);

  try {
    const workspace = await resolveWorkspace(pool);
    const ctx: Ctx = { db: pool, workspace, config, actor: "ingest" };

    // Extract candidates from every chunk (parallel).
    const perChunk = await Promise.all(
      chunks.map(async (c) => {
        const candidates = await extractDecisions(c.text, ctx);
        return candidates.map((cand) => ({ ...cand, doc: c.doc }));
      }),
    );

    // Flatten, filter by confidence, dedupe by normalized statement.
    const seen = new Set<string>();
    const kept: Array<{ text: string; confidence: number; doc: string }> = [];
    for (const cand of perChunk.flat()) {
      if (cand.confidence < minConfidence) continue;
      const key = normalize(cand.text);
      if (key.length < 8 || seen.has(key)) continue;
      seen.add(key);
      kept.push(cand);
    }
    kept.sort((a, b) => b.confidence - a.confidence);
    const finalSet = kept.slice(0, maxDecisions);

    console.log(`\nFound ${kept.length} unique decision(s) (confidence ≥ ${minConfidence}); recording ${finalSet.length}.\n`);

    if (dryRun) {
      for (const d of finalSet) {
        console.log(`  [${d.confidence.toFixed(2)}] (${d.doc}) ${d.text}`);
      }
      console.log("\n(DRY RUN — nothing written.)");
      return;
    }

    let recorded = 0;
    for (const d of finalSet) {
      const decision = await recordDecision(
        {
          statement: d.text,
          repo_id: repoId,
          author: "ingest",
          source_url: sourceUrl,
          rationale: `Ingested from ${d.doc}`,
        },
        ctx,
      );
      recorded++;
      console.log(`  recorded ${decision.id}  [${d.confidence.toFixed(2)}] ${d.text}`);
    }

    console.log(`\n✓ Ingested ${recorded} decision(s) under "${repoId}".`);

    // Smoke test: prove recall works on the freshly-ingested corpus.
    const probe = finalSet[0]?.text ?? "engineering convention";
    console.log(`\nRecall smoke test — query derived from top decision:`);
    const results = await recallDecisions(probe.slice(0, 80), { repo_id: repoId, limit: 3 }, ctx);
    for (const r of results) {
      console.log(`  [${r.similarity.toFixed(3)}] ${r.statement}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("ingest failed:", err);
  process.exit(1);
});
