import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { streamText } from "ai";
import { z } from "zod";
import type { AppEnv } from "./auth.js";
import {
  recallDecisions,
  recordDecision,
  getDecision,
  listDecisions,
  supersedeDecision,
  deleteDecision,
} from "../core/memory.js";
import { checkConflict } from "../core/review.js";
import {
  startBootstrap,
  getBootstrapStatus,
  readRepoSummary,
} from "../core/bootstrap.js";
import { extractDecisions } from "../core/extract.js";
import { getModel } from "../providers/llm.js";
import { CHAT_SYSTEM_PROMPT } from "../prompts.js";

const RecallSchema = z.object({
  query: z.string().min(1),
  repo: z.string().optional(),
  repo_id: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
  min_similarity: z.number().min(0).max(1).optional(),
});

const HunkSchema = z.object({
  start_line: z.number().int(),
  added: z.array(z.string()),
});
const FileSchema = z.object({
  path: z.string(),
  hunks: z.array(HunkSchema),
});
const CheckSchema = z.object({
  repo_id: z.string().optional(),
  repo: z.string().optional(),
  intent: z.string().optional(),
  snippet: z.string().optional(),
  files: z.array(FileSchema).optional(),
});

const RecordSchema = z.object({
  statement: z.string().min(1),
  rationale: z.string().optional(),
  repo_id: z.string().optional(),
  scope_globs: z.array(z.string()).optional(),
  context_code: z.string().optional(),
  source_url: z.string().optional(),
  author: z.string().optional(),
  supersedes_id: z.string().optional(),
});

const ExtractSchema = z.object({ text: z.string().min(1) });

const AskSchema = z.object({
  question: z.string().min(1),
  repo: z.string().optional(),
  repo_id: z.string().optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .optional(),
});

const OverrideSchema = z.object({
  decision_id: z.string(),
  location: z
    .object({
      path: z.string(),
      start_line: z.number().int(),
      end_line: z.number().int(),
    })
    .partial()
    .optional(),
  type: z.enum(["intentional", "accidental"]),
  actor: z.string().optional(),
});

const StatusEnum = z.enum(["active", "superseded", "deprecated"]);

/** Unauthenticated routes (mounted before the auth middleware in app.ts). */
export const health = new Hono<AppEnv>();

health.get("/v1/health", async (c) => {
  let db = "down";
  try {
    await c.get("db").query("SELECT 1");
    db = "up";
  } catch {
    db = "down";
  }
  return c.json({ ok: true, version: "2.0.0", db });
});

/** Authenticated `/v1/*` routes. The auth middleware is applied by app.ts. */
export const routes = new Hono<AppEnv>();

routes.post("/v1/recall", async (c) => {
  const ctx = c.get("ctx");
  const body = RecallSchema.parse(await c.req.json());
  const decisions = await recallDecisions(
    body.query,
    { repo_id: body.repo_id ?? body.repo, limit: body.limit, min_similarity: body.min_similarity },
    ctx,
  );
  return c.json({ decisions });
});

const BootstrapSchema = z.object({
  repo: z.string().optional(),
  repo_id: z.string().optional(),
  deep: z.boolean().optional(),
  force: z.boolean().optional(),
});

routes.post("/v1/bootstrap", async (c) => {
  const ctx = c.get("ctx");
  const body = BootstrapSchema.parse(await c.req.json());
  const repo = body.repo_id ?? body.repo;
  if (!repo) return c.json({ error: "repo is required" }, 400);
  // Non-blocking: kicks off background mining and returns immediately.
  const result = await startBootstrap(repo, { deep: body.deep, force: body.force }, ctx);
  return c.json(result);
});

routes.get("/v1/repos/status", async (c) => {
  const ctx = c.get("ctx");
  const repo = c.req.query("repo");
  if (!repo) return c.json({ error: "repo is required" }, 400);
  return c.json(await getBootstrapStatus(repo, ctx));
});

routes.get("/v1/repos/summary", async (c) => {
  const repo = c.req.query("repo");
  if (!repo) return c.json({ error: "repo is required" }, 400);
  const md = await readRepoSummary(repo);
  if (md === null) return c.json({ error: "no summary yet", markdown: null }, 404);
  return c.json({ repo_id: repo.toLowerCase(), markdown: md });
});

routes.post("/v1/check", async (c) => {
  const ctx = c.get("ctx");
  const body = CheckSchema.parse(await c.req.json());
  const conflicts = await checkConflict(
    {
      repo_id: body.repo_id ?? body.repo,
      intent: body.intent,
      snippet: body.snippet,
      files: body.files,
    },
    ctx,
  );
  return c.json({ conflicts });
});

routes.post("/v1/decisions", async (c) => {
  const ctx = c.get("ctx");
  const body = RecordSchema.parse(await c.req.json());
  const decision = await recordDecision(body, ctx);
  return c.json(decision, 201);
});

routes.get("/v1/decisions", async (c) => {
  const ctx = c.get("ctx");
  const repo = c.req.query("repo");
  const statusRaw = c.req.query("status");
  const status = statusRaw ? StatusEnum.parse(statusRaw) : undefined;
  const decisions = await listDecisions({ repo_id: repo, status }, ctx);
  return c.json({ decisions });
});

routes.get("/v1/decisions/:id", async (c) => {
  const ctx = c.get("ctx");
  const decision = await getDecision(c.req.param("id"), ctx);
  if (!decision) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(decision);
});

routes.post("/v1/decisions/:id/supersede", async (c) => {
  const ctx = c.get("ctx");
  const body = RecordSchema.parse(await c.req.json());
  const decision = await supersedeDecision(c.req.param("id"), body, ctx);
  return c.json(decision);
});

routes.delete("/v1/decisions/:id", async (c) => {
  const ctx = c.get("ctx");
  await deleteDecision(c.req.param("id"), ctx);
  return c.body(null, 204);
});

routes.post("/v1/extract", async (c) => {
  const ctx = c.get("ctx");
  const body = ExtractSchema.parse(await c.req.json());
  const candidates = await extractDecisions(body.text, ctx);
  return c.json({ candidates });
});

routes.post("/v1/ask", async (c) => {
  const ctx = c.get("ctx");
  const body = AskSchema.parse(await c.req.json());

  // RAG: recall the most relevant decisions, then stream a single grounded answer.
  const recalled = await recallDecisions(
    body.question,
    { repo_id: body.repo_id ?? body.repo, limit: 5 },
    ctx,
  );
  const citations = recalled.map((d) => d.id);
  const contextBlock = recalled.length
    ? recalled
        .map(
          (d) =>
            `[${d.id}] (sim ${d.similarity.toFixed(2)}) ${d.statement}${
              d.rationale ? ` — ${d.rationale}` : ""
            }`,
        )
        .join("\n")
    : "(no relevant decisions found)";

  const system = CHAT_SYSTEM_PROMPT(body.repo_id ?? body.repo ?? "this workspace");
  const userPrompt = `Relevant team decisions:\n${contextBlock}\n\nQuestion: ${body.question}\n\nAnswer using only the decisions above. Cite each decision you rely on inline as [decision_id]. If nothing is relevant, say so plainly.`;

  const messages = [
    ...(body.history ?? []),
    { role: "user" as const, content: userPrompt },
  ];

  return streamSSE(c, async (stream) => {
    const result = streamText({
      model: getModel(ctx.config),
      system,
      messages,
    });
    for await (const delta of result.textStream) {
      await stream.writeSSE({ event: "token", data: delta });
    }
    await stream.writeSSE({ event: "citations", data: JSON.stringify(citations) });
    await stream.writeSSE({ event: "done", data: "[DONE]" });
  });
});

routes.post("/v1/overrides", async (c) => {
  const ctx = c.get("ctx");
  const body = OverrideSchema.parse(await c.req.json());
  const actor = body.actor ?? ctx.actor ?? null;

  const inserted = await ctx.db.query(
    `INSERT INTO overrides (workspace_id, decision_id, repo_id, location, type, actor)
     VALUES (
       $1,
       $2,
       (SELECT repo_id FROM decisions WHERE id = $2 AND workspace_id = $1),
       $3::jsonb,
       $4::override_type,
       $5
     )
     RETURNING id`,
    [
      ctx.workspace.id,
      body.decision_id,
      body.location ? JSON.stringify(body.location) : null,
      body.type,
      actor,
    ],
  );

  void ctx.db
    .query(
      `INSERT INTO audit_log (workspace_id, actor, action, decision_id, metadata)
       VALUES ($1, $2, 'override', $3, $4::jsonb)`,
      [
        ctx.workspace.id,
        actor,
        body.decision_id,
        JSON.stringify({ type: body.type, location: body.location ?? null }),
      ],
    )
    .catch(() => {});

  return c.json({ id: inserted.rows[0].id }, 201);
});
