import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateText } from "ai";
import { extractDecisions } from "./extract.js";
import { recordDecision } from "./memory.js";
import { getModel } from "../providers/llm.js";
import type { Ctx } from "../types.js";

/**
 * Self-bootstrap a repo's decision memory from its own written signal so an
 * agent's FIRST interaction isn't against an empty corpus.
 *
 * ASYNC: `startBootstrap` kicks off mining in the background and returns
 * immediately (no 50s block in the IDE). Progress is tracked in an in-memory
 * job registry; the durable result lands in Postgres. On completion it also
 * writes an LLM-authored markdown summary of the repo's conventions to
 * `${SUMMARY_DIR}/<owner>__<repo>.md` (host-mounted).
 *
 * Server-side (no `gh` CLI) — works inside the container:
 *   - docs:    raw.githubusercontent.com
 *   - reviews: api.github.com PR review comments (GITHUB_TOKEN), each with its
 *              `diff_hunk` stored as `context_code` (code-anchored decisions).
 */

const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";
const SUMMARY_DIR = process.env.ARES_SUMMARY_DIR || join(process.cwd(), "summaries");

const DOC_PATHS = [
  // Markdown ecosystems
  "README.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  "docs/development/coding-style.md",
  "docs/contributing/Style-guide-for-Flutter-repo.md",
  "CONVENTIONS.md",
  "STYLE.md",
  // Extensionless / reStructuredText ecosystems (Linux, Python, Django, CPython…)
  "README",
  "README.rst",
  "CONTRIBUTING.rst",
  "CONTRIBUTING",
  "STYLE.rst",
  "Documentation/process/coding-style.rst",
  "Documentation/process/submitting-patches.rst",
  "Documentation/process/4.Coding.rst",
  "Documentation/process/maintainer-handbooks.rst",
  "Documentation/CodingStyle",
  "doc/coding_style.rst",
];

const JUNK_RE =
  /^(lgtm|sgtm|nit:?|thanks?|thank you|done|fixed|\+1|👍|ok(ay)?|sounds good|will do|ditto|same|agreed?|nice|cool|wdyt\??)\b/i;
const SIGNAL_RE =
  /\b(should(n't)?|shouldn'?t|don'?t|do not|never|always|avoid|prefer|instead|must(n't)?|we (use|don'?t|avoid|prefer)|let'?s not|need to|please (use|don'?t|avoid|prefer)|convention|by convention|not allowed|disallow|forbidden|use \w)\b/i;

const SUMMARY_SYSTEM = `You are writing a concise "engineering conventions" digest for a code repository, derived from decisions the team recorded (mined from their docs and PR review comments).

Group the decisions into themed sections with markdown headings (e.g. Code Style, Architecture & APIs, Testing, Dependencies, Performance, Documentation, Process). Under each, use short bullet points. Be faithful to the provided decisions — do NOT invent rules. Start with a 2-3 sentence overview of what this codebase cares about. Keep it skimmable.`;

export type BootstrapStatus = "empty" | "running" | "ready" | "error";

type Job = {
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  recorded?: number;
  scanned?: { docs: number; reviews: number };
  summaryPath?: string;
  error?: string;
};

// In-memory job registry (single long-lived server process). The durable
// source of truth is always Postgres; this just tracks in-flight mining.
const jobs = new Map<string, Job>();

export type BootstrapOpts = { deep?: boolean; force?: boolean };

type ReviewComment = {
  body?: string;
  diff_hunk?: string;
  path?: string;
  html_url?: string;
  user?: { login?: string; type?: string };
};

export async function countDecisions(repoId: string, ctx: Ctx): Promise<number> {
  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM decisions
      WHERE workspace_id = $1 AND repo_id = $2 AND status = 'active'`,
    [ctx.workspace.id, repoId.toLowerCase()],
  );
  return rows[0]?.n ?? 0;
}

export async function getBootstrapStatus(repoRaw: string, ctx: Ctx) {
  const repoId = repoRaw.toLowerCase();
  const count = await countDecisions(repoId, ctx);
  const job = jobs.get(repoId);
  let status: BootstrapStatus = "empty";
  if (job?.status === "running") status = "running";
  else if (count > 0) status = "ready";
  else if (job?.status === "error") status = "error";
  return {
    repo_id: repoId,
    count,
    status,
    recorded: job?.recorded,
    summary_path: job?.summaryPath,
    error: job?.error,
  };
}

/**
 * Non-blocking: returns immediately. If the repo is empty (or force), starts a
 * background mine. Idempotent — safe to call on every session.
 */
export async function startBootstrap(repoRaw: string, opts: BootstrapOpts, ctx: Ctx) {
  const repoId = repoRaw.toLowerCase();
  const existing = await countDecisions(repoId, ctx);

  if (existing > 0 && !opts.force) {
    return { repo_id: repoId, status: "ready" as BootstrapStatus, started: false, existing };
  }
  const current = jobs.get(repoId);
  if (current?.status === "running") {
    return { repo_id: repoId, status: "running" as BootstrapStatus, started: false, existing };
  }

  jobs.set(repoId, { status: "running", startedAt: Date.now() });
  // Fire-and-forget: do NOT await. The long-lived server process keeps running
  // this after the HTTP response returns.
  void runBootstrap(repoId, opts, ctx)
    .then((res) => {
      jobs.set(repoId, {
        status: "done",
        startedAt: current?.startedAt ?? Date.now(),
        finishedAt: Date.now(),
        recorded: res.recorded,
        scanned: res.scanned,
        summaryPath: res.summaryPath,
      });
    })
    .catch((err: unknown) => {
      console.error(`bootstrap ${repoId} failed:`, err);
      jobs.set(repoId, {
        status: "error",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        error: (err as Error).message,
      });
    });

  return { repo_id: repoId, status: "running" as BootstrapStatus, started: true, existing };
}

// ---- internals ----

function ghHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "ares-bootstrap",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchRaw(repo: string, path: string): Promise<string | null> {
  for (const ref of ["HEAD", "main", "master"]) {
    try {
      const res = await fetch(`${RAW}/${repo}/${ref}/${path}`);
      if (res.ok) return await res.text();
    } catch {
      /* try next ref */
    }
  }
  return null;
}

async function fetchReviewPage(repo: string, page: number, token?: string): Promise<ReviewComment[]> {
  try {
    const res = await fetch(
      `${API}/repos/${repo}/pulls/comments?per_page=100&sort=created&direction=desc&page=${page}`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) return [];
    return (await res.json()) as ReviewComment[];
  } catch {
    return [];
  }
}

function chunkDoc(text: string, target = 1500): string[] {
  const clean = text.replace(/```[\s\S]*?```/g, " ");
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

async function runBootstrap(repoId: string, opts: BootstrapOpts, ctx: Ctx) {
  const token = ctx.config.githubToken;
  const maxReviewPages = opts.deep ? 30 : 2;
  const maxExtract = opts.deep ? 600 : 80;
  const maxDecisions = opts.deep ? 200 : 60;
  const minConfidence = 0.6;
  const sourceUrl = `https://github.com/${repoId}`;

  type Item = { body: string; context?: string; author?: string; url?: string };
  const items: Item[] = [];
  let docCount = 0;
  let reviewCount = 0;

  for (const path of DOC_PATHS) {
    const text = await fetchRaw(repoId, path);
    if (!text || text.trim().length === 0) continue;
    docCount++;
    for (const ch of chunkDoc(text)) {
      items.push({ body: ch, url: `${sourceUrl}/blob/HEAD/${path}` });
      if (items.length >= maxExtract) break;
    }
    if (items.length >= maxExtract) break;
  }

  for (let page = 1; page <= maxReviewPages && items.length < maxExtract; page++) {
    const batch = await fetchReviewPage(repoId, page, token);
    if (batch.length === 0) break;
    for (const c of batch) {
      const body = (c.body ?? "").trim();
      if (body.length < 40) continue;
      if (c.user?.type === "Bot" || (c.user?.login ?? "").endsWith("[bot]")) continue;
      if (JUNK_RE.test(body) || !SIGNAL_RE.test(body)) continue;
      reviewCount++;
      items.push({
        body,
        context: (c.diff_hunk ?? "").slice(0, 1500) || undefined,
        author: c.user?.login ? `@${c.user.login}` : undefined,
        url: c.html_url,
      });
      if (items.length >= maxExtract) break;
    }
    if (batch.length < 100) break;
  }

  type Found = { text: string; confidence: number; item: Item };
  const toExtract = items.slice(0, maxExtract);
  const found: Found[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < toExtract.length; i += CONCURRENCY) {
    const slice = toExtract.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (it) => {
        const cands = await extractDecisions(it.body, ctx);
        return cands.map((cd) => ({ text: cd.text, confidence: cd.confidence, item: it }));
      }),
    );
    for (const r of results) found.push(...r);
  }

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

  let recorded = 0;
  for (const f of finalSet) {
    await recordDecision(
      {
        statement: f.text,
        repo_id: repoId,
        author: f.item.author,
        source_url: f.item.url ?? sourceUrl,
        context_code: f.item.context,
        rationale: f.item.context ? "Mined from PR review comment" : "Ingested from repo docs",
      },
      ctx,
    );
    recorded++;
  }

  const summaryPath = await generateRepoSummary(repoId, ctx).catch((e) => {
    console.error(`summary generation failed for ${repoId}:`, e);
    return undefined;
  });

  return { recorded, scanned: { docs: docCount, reviews: reviewCount }, summaryPath };
}

/**
 * Synthesize a human-readable markdown digest of the repo's conventions from
 * the recorded decisions, written to ${SUMMARY_DIR}/<owner>__<repo>.md.
 */
export async function generateRepoSummary(repoId: string, ctx: Ctx): Promise<string | undefined> {
  const { rows } = await ctx.db.query(
    `SELECT statement, author, source_url FROM decisions
      WHERE workspace_id = $1 AND repo_id = $2 AND status = 'active'
      ORDER BY created_at`,
    [ctx.workspace.id, repoId.toLowerCase()],
  );
  if (rows.length === 0) return undefined;

  const list = rows
    .slice(0, 140)
    .map((d, i) => `${i + 1}. ${d.statement}${d.author ? ` (${d.author})` : ""}`)
    .join("\n");

  let digest = "";
  try {
    const { text } = await generateText({
      model: getModel(ctx.config),
      system: SUMMARY_SYSTEM,
      prompt: `Repository: ${repoId}\n\nRecorded decisions:\n${list}\n\nWrite the engineering-conventions digest now.`,
    });
    digest = text;
  } catch (e) {
    digest = "_(LLM digest unavailable; raw decisions listed below.)_";
  }

  const md = `# ARES memory — ${repoId}

> Auto-generated by ARES from ${rows.length} decision(s) mined from this repo's docs and PR review comments.
> Generated ${new Date().toISOString()}.

${digest}

---

## All recorded decisions (${rows.length})

${rows
  .map(
    (d) =>
      `- ${d.statement}${d.author ? ` — ${d.author}` : ""}${
        d.source_url ? ` ([source](${d.source_url}))` : ""
      }`,
  )
  .join("\n")}
`;

  await mkdir(SUMMARY_DIR, { recursive: true });
  const file = join(SUMMARY_DIR, `${repoId.replace(/\//g, "__")}.md`);
  await writeFile(file, md, "utf8");
  console.log(`wrote repo summary → ${file}`);
  return file;
}

/** Read a previously-generated summary markdown, if present. */
export async function readRepoSummary(repoId: string): Promise<string | null> {
  const file = join(SUMMARY_DIR, `${repoId.toLowerCase().replace(/\//g, "__")}.md`);
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}
