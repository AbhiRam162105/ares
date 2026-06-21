import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../config.js";
import { makePool } from "../db.js";
import { hashKey } from "../http/auth.js";
import { extractDecisions } from "../core/extract.js";
import { recordDecision, recallDecisions } from "../core/memory.js";
import type { Ctx, Workspace } from "../types.js";

const exec = promisify(execFile);

/**
 * Contextual decision miner — pulls real engineering decisions from a repo's
 * PR REVIEW COMMENTS (the "we decided X because Y" knowledge), each of which
 * carries the `diff_hunk` it was written about. We store that hunk as
 * `context_code`, so mined decisions are CODE-ANCHORED — which both preserves
 * provenance (author + permalink) and makes `check_conflict` on code work for
 * decisions that a bare style guide would express too abstractly.
 *
 * Source: GitHub review comments via the authenticated `gh` CLI (5000 req/hr).
 *
 * Usage:
 *   npm run mine -- --github flutter/flutter --max-extract 600 --max-decisions 200
 *
 * Flags:
 *   --github owner/repo   (required) repo to mine; also the repo_id stored
 *   --repo owner/repo     override the stored repo_id
 *   --max-pages N         GitHub pages of 100 comments to scan (default 60 = ~6k comments)
 *   --max-extract N       cap on LLM extraction calls (cost ceiling; default 600)
 *   --max-decisions N     cap on decisions recorded (default 200)
 *   --min-confidence X    keep candidates with confidence >= X (default 0.6)
 *   --dry-run             print would-be decisions; write nothing
 */

type ReviewComment = {
  body: string;
  diff_hunk?: string;
  path?: string;
  html_url?: string;
  user?: { login?: string; type?: string };
  pull_request_url?: string;
};

// Comments that are noise, not decisions.
const JUNK_RE =
  /^(lgtm|sgtm|nit:?|thanks?|thank you|done|fixed|\+1|👍|ok(ay)?|sounds good|will do|ditto|same|agreed?|nice|cool|wdyt\??)\b/i;
// Comments that likely encode a decision/convention.
const SIGNAL_RE =
  /\b(should(n't)?|shouldn'?t|don'?t|do not|never|always|avoid|prefer|instead|must(n't)?|we (use|don'?t|avoid|prefer)|let'?s not|need to|please (use|don'?t|avoid|prefer)|convention|by convention|not allowed|disallow|forbidden|use \w)\b/i;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function fetchReviewCommentsPage(
  ownerRepo: string,
  page: number,
): Promise<ReviewComment[]> {
  const { stdout } = await exec(
    "gh",
    [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `repos/${ownerRepo}/pulls/comments?per_page=100&sort=created&direction=desc&page=${page}`,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as ReviewComment[];
}

function isCandidate(c: ReviewComment): boolean {
  const body = (c.body ?? "").trim();
  if (body.length < 40) return false;
  if (c.user?.type === "Bot" || (c.user?.login ?? "").endsWith("[bot]")) return false;
  if (JUNK_RE.test(body)) return false;
  return SIGNAL_RE.test(body);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function resolveWorkspace(
  pool: Awaited<ReturnType<typeof makePool>>,
): Promise<Workspace> {
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
  if (!res.rows[0]) throw new Error("No workspace found. Run `npm run seed` first.");
  return res.rows[0];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const github = typeof args.github === "string" ? args.github : undefined;
  if (!github) throw new Error("--github owner/repo is required");
  const repoId = ((typeof args.repo === "string" && args.repo) || github).toLowerCase();

  const maxPages = Number(args["max-pages"] ?? 60);
  const maxExtract = Number(args["max-extract"] ?? 600);
  const maxDecisions = Number(args["max-decisions"] ?? 200);
  const minConfidence = Number(args["min-confidence"] ?? 0.6);
  const dryRun = args["dry-run"] === true;

  console.log("─".repeat(70));
  console.log(`ARES mine (PR review comments) → repo_id "${repoId}"  ${dryRun ? "(DRY RUN)" : ""}`);
  console.log(`Scanning up to ${maxPages} pages · extract cap ${maxExtract} · record cap ${maxDecisions}`);

  // 1. Page through recent review comments, collecting high-signal candidates.
  const candidates: ReviewComment[] = [];
  for (let page = 1; page <= maxPages; page++) {
    let batch: ReviewComment[];
    try {
      batch = await fetchReviewCommentsPage(github, page);
    } catch (err) {
      console.warn(`  page ${page} fetch failed: ${(err as Error).message}`);
      break;
    }
    if (batch.length === 0) break;
    const kept = batch.filter(isCandidate);
    candidates.push(...kept);
    if (page % 10 === 0 || batch.length < 100) {
      console.log(`  page ${page}: +${kept.length} signal / ${batch.length} scanned (total candidates ${candidates.length})`);
    }
    if (candidates.length >= maxExtract) break;
    if (batch.length < 100) break; // last page
  }

  const toExtract = candidates.slice(0, maxExtract);
  console.log(`\nExtracting from ${toExtract.length} high-signal review comment(s)...`);

  const config = loadConfig();
  const pool = await makePool(config);

  try {
    const workspace = await resolveWorkspace(pool);
    const ctx: Ctx = { db: pool, workspace, config, actor: "mine:reviews" };

    // 2. Extract decisions from each comment (parallel, throttled in chunks).
    type Found = { text: string; confidence: number; comment: ReviewComment };
    const found: Found[] = [];
    const CONCURRENCY = 8;
    for (let i = 0; i < toExtract.length; i += CONCURRENCY) {
      const slice = toExtract.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map(async (c) => {
          const cands = await extractDecisions(c.body, ctx);
          return cands.map((cand) => ({ ...cand, comment: c }));
        }),
      );
      for (const r of results) found.push(...r);
      process.stdout.write(`\r  extracted ${Math.min(i + CONCURRENCY, toExtract.length)}/${toExtract.length}   `);
    }
    process.stdout.write("\n");

    // 3. Filter by confidence, dedupe by normalized statement.
    const seen = new Set<string>();
    const kept: Found[] = [];
    for (const f of found) {
      if (f.confidence < minConfidence) continue;
      const key = normalize(f.text);
      if (key.length < 8 || seen.has(key)) continue;
      seen.add(key);
      kept.push(f);
    }
    kept.sort((a, b) => b.confidence - a.confidence);
    const finalSet = kept.slice(0, maxDecisions);

    console.log(`Found ${kept.length} unique decision(s); recording ${finalSet.length}.\n`);

    if (dryRun) {
      for (const f of finalSet.slice(0, 60)) {
        console.log(`  [${f.confidence.toFixed(2)}] @${f.comment.user?.login ?? "?"} ${f.text}`);
      }
      console.log("\n(DRY RUN — nothing written.)");
      return;
    }

    let recorded = 0;
    for (const f of finalSet) {
      const hunk = (f.comment.diff_hunk ?? "").slice(0, 1500);
      await recordDecision(
        {
          statement: f.text,
          repo_id: repoId,
          author: f.comment.user?.login ? `@${f.comment.user.login}` : undefined,
          source_url: f.comment.html_url,
          context_code: hunk || undefined,
          rationale: `Mined from PR review comment${f.comment.path ? ` on ${f.comment.path}` : ""}`,
        },
        ctx,
      );
      recorded++;
      if (recorded % 20 === 0) process.stdout.write(`\r  recorded ${recorded}/${finalSet.length}   `);
    }
    console.log(`\n✓ Mined & recorded ${recorded} code-anchored decision(s) under "${repoId}".`);

    const probe = finalSet[0]?.text ?? "code review convention";
    console.log(`\nRecall smoke test:`);
    const results = await recallDecisions(probe.slice(0, 80), { repo_id: repoId, limit: 3 }, ctx);
    for (const r of results) console.log(`  [${r.similarity.toFixed(3)}] ${r.statement.slice(0, 70)}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("mine failed:", err);
  process.exit(1);
});
