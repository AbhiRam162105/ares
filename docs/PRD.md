# ARES v2 — Implementation PRD

**Agent Recall & Enforcement Substrate**
*The decision-memory layer for AI coding agents. Your codebase forgets. ARES doesn't.*

> Supersedes `ARES_PRD.md` (v1, the Cloudflare Hackathon build). v1 is preserved for reference but its
> Cloudflare-specific architecture is **deprecated** by this document. Section 15 is the atomic edit plan
> that converts the v1 repo into the v2 repo, file by file.

---

## 0. How to Read This Document

Every operation in ARES v2 is specified at the atomic level: function signature, inputs, outputs, side
effects, error modes, and the file it lives in. A developer can implement any single function in isolation
and have it compose correctly.

- **Sections 1–3** — the pivot, positioning, and architecture.
- **Sections 4–9** — the implementation surface (data model, core engine, providers, MCP server, REST API, auth).
- **Sections 10–14** — extension changes, file tree, configs, prompts, integration recipes.
- **Section 15** — **the atomic migration plan**: every file to delete, modify, or add to convert v1 → v2.
- **Sections 16–20** — flows, enterprise concerns, acceptance criteria, risks, open decisions.

---

## 1. The Pivot

### 1.1 What changed and why

ARES v1 was a **post-hoc reviewer**: a Chrome extension that scolded a human *after* they opened a PR. The
honest critique: that is a feature, not a company. In an agent-coded world, the highest-leverage moment is
**write time** — the instant a coding agent (Cursor, Claude Code, Copilot, Windsurf, Cline, Codex) is about
to generate code. The question worth the most money is: *"What has this team already decided about this?"*

ARES v2 repositions from **reviewer** to **substrate**:

> ARES is the neutral, write-time **decision-memory layer** that any coding agent or reviewer queries —
> over MCP or REST — *before* and *during* code generation. It accumulates a corpus of engineering
> decisions that compounds regardless of which IDE, agent, or reviewer a team uses.

### 1.2 Strategic consequences (these shape the architecture)

1. **MCP is the primary interface, not the Chrome extension.** Any MCP-capable agent must be able to call
   `recall_decisions` and `check_conflict` with zero ARES-specific code. The extension becomes one of
   several clients of the same API, not the product.
2. **The corpus is the lock-in, so never tax it.** Storing decisions is always free and unlimited. Metering
   is on *seats* and *query volume*, never on stored decisions. (Schema and limits reflect this — no row
   caps on `decisions`.)
3. **Neutral substrate ⇒ vendor-agnostic everything.** No hard dependency on a single cloud, embedder, or
   LLM. Cloudflare is removed entirely. Embeddings and LLM are pluggable providers behind interfaces.
4. **Decisions evolve.** Enterprises need lifecycle: `active → superseded → deprecated`, with an audit
   trail. v1's "one immutable row" model is replaced.
5. **Multi-tenant from day one.** A `workspace` (team/org) owns decisions, scoped optionally to a `repo`
   and/or path globs. API keys map to a workspace.

### 1.3 Non-goals (kept deliberately out)

- Training/fine-tuning a custom model (we orchestrate off-the-shelf embedders + LLMs).
- A hosted IDE or our own agent. ARES feeds *other* agents.
- Real-time collaboration / CRDTs. Decisions are low-write, high-read.

---

## 2. Stack (Cloudflare fully removed)

| Layer | v1 (removed) | v2 (chosen) | Rationale |
|---|---|---|---|
| Runtime | CF Workers | **Node.js 22 LTS, ESM, TypeScript** | Runs anywhere (Docker, ECS, Fly, bare metal, laptop). MCP SDK + pg are Node-native. |
| HTTP router | Hono on Workers | **Hono on `@hono/node-server`** | Keep the Hono API surface; swap the adapter. Portable, tiny. |
| Agent/IDE interface | *(none)* | **MCP via `@modelcontextprotocol/sdk`** (stdio + Streamable HTTP) | The headline. stdio for local spawn by any IDE; Streamable HTTP for hosted/remote. |
| Vector store | Vectorize | **Postgres 16 + pgvector 0.8 (`halfvec`, HNSW, cosine)** | Collapses metadata + vectors into **one** ACID store. Runs on RDS/Neon/Supabase/self-host. |
| Metadata store | D1 (SQLite) | **same Postgres** | One database for everything. No two-store consistency problem. |
| Embeddings | Workers AI BGE (768) | **Pluggable: OpenAI `text-embedding-3-small` (1536) default; local `fastembed`/transformers.js (384) for air-gapped** | Vendor-neutral; offline option for enterprise data residency. |
| LLM (judge/extract/ask) | OpenAI via AI Gateway | **Vercel AI SDK, provider-agnostic** (`@ai-sdk/openai`, `@ai-sdk/anthropic`, Ollama) | `generateObject` keeps structured output; provider chosen by env. |
| Chat state | Durable Object (Agents SDK) | **Stateless `/v1/ask` (RAG over `recall`)** | DO removed; no per-repo durable chat needed. History (if any) lives in Postgres. |
| Auth | single bearer in env | **Per-workspace API keys (hashed in Postgres)** | Multi-tenant; revocable; audited. |
| Deploy | `wrangler deploy` | **Docker + docker-compose; `npx @ares/mcp` for local** | No proprietary deploy path. |
| Extension | MV3, GitHub-only | **MV3, repointed to ARES API** | Demoted to one client among many. |

**Dropped dependencies:** `wrangler`, `agents`, `@cloudflare/workers-types`, Vectorize, D1, Workers AI, AI
Gateway, Durable Objects.

**Added dependencies:** `@modelcontextprotocol/sdk`, `pg`, `pgvector`, `@hono/node-server`,
`@ai-sdk/anthropic`, `tsx` (dev), `vitest` (dev).

---

## 3. Architecture

```
            ┌──────────────────────── MCP clients (any IDE/agent) ────────────────────────┐
            │  Cursor · Claude Code/Desktop · Copilot · Windsurf · Cline · Codex · CI bots │
            └───────────────┬─────────────────────────────────────────┬───────────────────┘
                            │ stdio (local spawn: `ares-mcp`)          │ Streamable HTTP (remote)
                            ▼                                          ▼
            ┌──────────────────────────────────────────────────────────────────────────────┐
            │  ARES Server (Node + Hono)                                                     │
            │                                                                                │
            │  MCP surface (src/mcp/server.ts)            REST surface (src/http/routes.ts)  │
            │   tool  recall_decisions     ─┐              POST /v1/recall      ─┐           │
            │   tool  check_conflict        │              POST /v1/check        │           │
            │   tool  record_decision       │  share       POST /v1/decisions    │  share    │
            │   tool  list_decisions        ├─ core ──►    GET  /v1/decisions     ├─ core ──► │
            │   tool  get_decision          │              GET  /v1/decisions/:id │           │
            │   tool  supersede_decision   ─┘              POST /v1/.../supersede │           │
            │   resource ares://decisions/{id}             POST /v1/extract       │           │
            │   resource ares://repo/{repo}/decisions      POST /v1/ask           │           │
            │                                              POST /v1/overrides     │           │
            │                                              GET  /v1/health       ─┘           │
            │                                                                                │
            │  Core engine (src/core/*)   Providers (src/providers/*)                        │
            │   memory.ts  recordDecision  embeddings.ts  embed/embedBatch (OpenAI|local)    │
            │   review.ts  checkConflict   llm.ts         generateObject/getModel (OpenAI|…) │
            │   judge.ts   judgeConflict                                                     │
            │   extract.ts extractDecisions                                                  │
            └───────────────────────────────────┬────────────────────────────────────────────┘
                                                 ▼
                          ┌───────────────────────────────────────────────┐
                          │  PostgreSQL 16 + pgvector 0.8                  │
                          │   workspaces · api_keys · decisions(halfvec)  │
                          │   overrides · audit_log                       │
                          │   HNSW(halfvec_cosine_ops) on decisions.embed │
                          └───────────────────────────────────────────────┘
```

### 3.1 Boundaries / invariants

- **Embeddings happen server-side** so any client can call `recall`/`check` with raw text/diff and no SDK.
- **One store.** A decision's metadata and its vector live in the same Postgres row. No cross-store sync.
- **Stateless server.** Horizontal scaling is trivial; all state is in Postgres. (MCP Streamable HTTP runs
  in stateless mode — `sessionIdGenerator: undefined`.)
- **Workspace isolation.** Every query is filtered by `workspace_id` resolved from the API key. No query
  ever crosses workspaces.

---

## 4. Data Model

### 4.1 Postgres schema (`server/migrations/0001_init.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector 0.8+
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- A team/org. Owns everything below it.
CREATE TABLE workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  embed_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  embed_dim   INTEGER NOT NULL DEFAULT 1536,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys map a bearer token to a workspace. Store only the hash.
CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,         -- sha256(token), hex
  key_prefix   TEXT NOT NULL,                -- first 8 chars, for display
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

-- The corpus. NEVER metered. embedding is halfvec for 50% smaller index.
CREATE TYPE decision_status AS ENUM ('active', 'superseded', 'deprecated');

CREATE TABLE decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id       TEXT,                          -- "owner/repo" lowercase, NULL = workspace-wide
  scope_globs   TEXT[] NOT NULL DEFAULT '{}',  -- optional path scoping, e.g. {"src/auth/**"}
  statement     TEXT NOT NULL,                 -- the imperative decision
  rationale     TEXT,                          -- why (the "we got burned by…" story)
  context_code  TEXT,                          -- code/diff that motivated it
  source_url    TEXT,
  author        TEXT,
  status        decision_status NOT NULL DEFAULT 'active',
  supersedes_id UUID REFERENCES decisions(id) ON DELETE SET NULL,
  embedding     halfvec(1536) NOT NULL,        -- dim MUST match workspace.embed_dim
  embed_model   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_decisions_workspace ON decisions(workspace_id);
CREATE INDEX idx_decisions_repo      ON decisions(workspace_id, repo_id);
CREATE INDEX idx_decisions_status    ON decisions(workspace_id, status);

-- Vector index: HNSW + halfvec + cosine. Query MUST use <=> and ::halfvec(1536).
CREATE INDEX idx_decisions_embedding ON decisions
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Persisted overrides (enterprise governance; v1 was client-only).
CREATE TYPE override_type AS ENUM ('intentional', 'accidental');

CREATE TABLE overrides (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision_id  UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  repo_id      TEXT,
  location     JSONB,                          -- { path, start_line, end_line }
  type         override_type NOT NULL,
  actor        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit trail for governance.
CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor        TEXT,
  action       TEXT NOT NULL,                  -- 'record'|'recall'|'check'|'supersede'|'override'|'delete'
  decision_id  UUID,
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_workspace ON audit_log(workspace_id, created_at DESC);
```

> Note: `embed_dim` is per-workspace, but the column type `halfvec(1536)` is fixed at migration time. For
> v2 we standardize on **1536** (OpenAI `text-embedding-3-small`). The local fastembed option must be
> projected/padded to 1536, OR run a separate deployment with a `halfvec(384)` migration variant. See §6.3.

### 4.2 Query-time tuning

Set once per connection (in `db.ts` after connect, see §6.1):
```sql
SET hnsw.ef_search = 100;            -- recall/latency sweet spot; must be >= LIMIT
```
Recall pattern (the only vector query in the system):
```sql
SELECT *, 1 - (embedding <=> $1::halfvec(1536)) AS similarity
FROM decisions
WHERE workspace_id = $2
  AND status = 'active'
  AND ($3::text IS NULL OR repo_id = $3 OR repo_id IS NULL)
ORDER BY embedding <=> $1::halfvec(1536)
LIMIT $4;
```

---

## 5. Core Engine — Atomic Operations

All core functions take a `Ctx` (request context) as the last arg instead of v1's `Env`:

```typescript
// src/types.ts
export type Ctx = {
  db: Pool;                 // pg pool
  workspace: Workspace;     // resolved from API key
  config: Config;           // providers, thresholds
  actor?: string;           // for audit
};
```

### 5.1 `server/src/core/memory.ts`

#### `recordDecision(input: RecordInput, ctx: Ctx): Promise<Decision>`

| | |
|---|---|
| **Purpose** | Store a new decision (metadata + embedding) in one Postgres row |
| **Input** | `{ statement, rationale?, repo_id?, scope_globs?, context_code?, source_url?, author? }` |
| **Steps** | 1. `vec = await embed(statement + "\n" + (rationale ?? "") + "\n" + (context_code ?? ""), ctx)`<br>2. `INSERT INTO decisions (...) VALUES (...) RETURNING *` with `embedding = $vec::halfvec`<br>3. `writeAudit(ctx, 'record', row.id)` |
| **Errors** | Embedder throws → bubble 502; DB unique/constraint → 400 |
| **Output** | full `Decision` |

#### `recallDecisions(query: string, opts: RecallOpts, ctx: Ctx): Promise<ScoredDecision[]>`

| | |
|---|---|
| **Purpose** | **The write-time call.** Semantic search over the workspace's active decisions |
| **Input** | `query`; `opts = { repo_id?, limit = 5, min_similarity = 0.3 }` |
| **Steps** | 1. `vec = await embed(query, ctx)`<br>2. run §4.2 recall SQL with `LIMIT = opts.limit`<br>3. map rows → `ScoredDecision` (attach `similarity = 1 - distance`)<br>4. filter `similarity >= min_similarity`<br>5. `writeAudit(ctx, 'recall', null, { query, n: results.length })` |
| **Output** | `ScoredDecision[]` ordered by similarity desc |

#### `getDecision(id, ctx): Promise<Decision | null>`
`SELECT * FROM decisions WHERE id = $1 AND workspace_id = $2`.

#### `listDecisions(filter: { repo_id?, status? }, ctx): Promise<Decision[]>`
`SELECT * ... WHERE workspace_id = $1 [AND repo_id][AND status] ORDER BY created_at DESC`.

#### `supersedeDecision(id, input: RecordInput, ctx): Promise<Decision>`
Transaction: `UPDATE decisions SET status='superseded', updated_at=now() WHERE id=$id`; then
`recordDecision({ ...input, supersedes_id: id })`; audit `supersede`. Returns the new decision.

#### `deprecateDecision(id, ctx): Promise<void>`
`UPDATE decisions SET status='deprecated' ...`; audit.

#### `deleteDecision(id, ctx): Promise<void>`
Hard `DELETE` (cascade removes overrides referencing it); audit `delete`. (Used by admin UI/extension.)

### 5.2 `server/src/core/judge.ts`

#### `judgeConflict(decision: Decision, hunk: string, ctx: Ctx): Promise<JudgeResult>`
Identical contract to v1, now provider-agnostic:
```typescript
const { object } = await generateObject({
  model: getModel(ctx.config),                 // OpenAI|Anthropic|… from config
  schema: JudgeSchema,                          // { is_conflict, confidence, reasoning }
  system: JUDGE_SYSTEM,
  prompt: buildJudgeUserMessage(decision, hunk),
});
```
On any throw → `{ is_conflict: false, confidence: 0, reasoning: "judge_failed" }`.

### 5.3 `server/src/core/extract.ts`

#### `extractDecisions(text: string, ctx: Ctx): Promise<Candidate[]>`
`generateObject({ model: getModel(ctx.config), schema: ExtractSchema, system: EXTRACT_SYSTEM, prompt: text })`.
On throw → `[]`.

### 5.4 `server/src/core/review.ts`

#### `checkConflict(input: CheckInput, ctx: Ctx): Promise<Conflict[]>`

| | |
|---|---|
| **Purpose** | The guardrail: given new code (snippet or files+hunks) and optional intent, return conflicts |
| **Input** | `{ repo_id?, intent?, files: Array<{ path, hunks: Array<{ start_line, added: string[] }> }> }` OR `{ repo_id?, intent?, snippet: string }` |
| **Algorithm** | 1. Build `chunks[]` + `chunkLocs[]` (one per hunk; `"file: ${path}\n${added}"`). For `snippet` mode, one chunk.<br>2. `embeddings = await embedBatch(chunks, ctx)`.<br>3. For each embedding: recall SQL `topK=3` (active, repo-scoped); keep `similarity > config.similarityThreshold` (default **0.35** — the cheap recall pre-filter; the judge LLM is the precision gate, so favor recall. With `text-embedding-3-small`, code-vs-prose scores ~0.35–0.55; pass `intent` to lift recall). When `input.intent` is set, it is blended into each chunk's embedded text.<br>4. Dedupe by `decision_id`, keep best-similarity chunk.<br>5. For each survivor (parallel): `judge = judgeConflict(decision, chunks[idx], ctx)`; discard if `!is_conflict || confidence < config.confidenceThreshold` (default **0.6**).<br>6. `writeAudit(ctx, 'check', null, { conflicts: n })`.<br>7. Return `Conflict[]` with `id = randomUUID()`, full `decision`, `location`, `similarity`, `confidence`, `reasoning`. |
| **Latency** | embed batch ~300ms · recall (indexed) ~30ms · 1–3 judge calls parallel ~1500ms ≈ <2s |

### 5.5 Shared types (`server/src/types.ts`)

```typescript
export type Decision = {
  id: string; workspace_id: string; repo_id: string | null;
  scope_globs: string[]; statement: string; rationale: string | null;
  context_code: string | null; source_url: string | null; author: string | null;
  status: 'active' | 'superseded' | 'deprecated'; supersedes_id: string | null;
  embed_model: string; created_at: string; updated_at: string;
};
export type ScoredDecision = Decision & { similarity: number };
export type Conflict = {
  id: string; decision: Decision;
  location: { path: string; start_line: number; end_line: number } | null;
  similarity: number; confidence: number; reasoning: string;
};
export type JudgeResult = { is_conflict: boolean; confidence: number; reasoning: string };
export type Candidate = { text: string; confidence: number };
export type Workspace = { id: string; name: string; embed_model: string; embed_dim: number };
export type RecordInput = {
  statement: string; rationale?: string; repo_id?: string; scope_globs?: string[];
  context_code?: string; source_url?: string; author?: string; supersedes_id?: string;
};
export type RecallOpts = { repo_id?: string; limit?: number; min_similarity?: number };
export type CheckInput = {
  repo_id?: string; intent?: string;
  files?: Array<{ path: string; hunks: Array<{ start_line: number; added: string[] }> }>;
  snippet?: string;
};
```

---

## 6. Providers (pluggable, vendor-neutral)

### 6.1 `server/src/db.ts`

```typescript
import { Pool } from "pg";
import pgvector from "pgvector/pg";

export async function makePool(config: Config): Promise<Pool> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  pool.on("connect", async (client) => {
    await pgvector.registerTypes(client);          // halfvec/vector <-> number[]
    await client.query("SET hnsw.ef_search = 100");
  });
  return pool;
}
```

### 6.2 `server/src/config.ts`

Reads env once, selects providers, exposes thresholds:
```typescript
export type Config = {
  databaseUrl: string;
  embedProvider: "openai" | "local";
  embedModel: string;          // default 'text-embedding-3-small'
  embedDim: number;            // default 1536
  llmProvider: "openai" | "anthropic" | "ollama";
  llmModel: string;            // default 'gpt-4o-mini'
  openaiApiKey?: string;
  anthropicApiKey?: string;
  similarityThreshold: number; // default 0.35 (recall pre-filter; judge LLM is precision gate)
  confidenceThreshold: number; // default 0.6
  port: number;
};
export function loadConfig(env = process.env): Config { /* parse + defaults */ }
```

### 6.3 `server/src/providers/embeddings.ts`

```typescript
export async function embed(text: string, ctx: Ctx): Promise<number[]>;
export async function embedBatch(texts: string[], ctx: Ctx): Promise<number[][]>;
```
- `openai`: Vercel AI SDK `embedMany({ model: openai.embedding(config.embedModel), values })`.
- `local`: `fastembed` (`bge-small-en-v1.5`, 384-dim) — **requires the `halfvec(384)` schema variant**
  (`migrations/0001_init.local.sql`) and `embed_dim=384`. Document this as the air-gapped path.
- Invariant: returned dimension **must** equal `ctx.workspace.embed_dim`; assert and throw otherwise.

### 6.4 `server/src/providers/llm.ts`

```typescript
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
export function getModel(config: Config) {
  switch (config.llmProvider) {
    case "anthropic": return anthropic(config.llmModel);
    case "ollama":    return /* ollama provider */;
    default:          return openai(config.llmModel);
  }
}
```
No AI Gateway, no Cloudflare baseURL. The provider's default endpoint (or `OPENAI_BASE_URL`) is used.

---

## 7. MCP Server — the headline (`server/src/mcp/server.ts`)

Built with `@modelcontextprotocol/sdk`. One `buildMcpServer(ctx)` factory used by both transports.

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function buildMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "ares", version: "2.0.0" });

  server.registerTool("recall_decisions", {
    title: "Recall team decisions",
    description: "BEFORE writing code, search the team's past engineering decisions for this repo by meaning. Call this whenever you are about to implement something that might have an established convention (auth, caching, IDs, retries, error handling, dependencies).",
    inputSchema: { query: z.string(), repo: z.string().optional(), limit: z.number().int().min(1).max(20).default(5) },
  }, async ({ query, repo, limit }) => {
    const results = await recallDecisions(query, { repo_id: repo, limit }, ctx);
    return { content: [{ type: "text", text: formatDecisionsForAgent(results) }],
             structuredContent: { decisions: results } };
  });

  server.registerTool("check_conflict", {
    title: "Check code against memory",
    description: "Given code you just wrote (a snippet or diff), check whether it conflicts with a past decision. Returns conflicts with the violated decision and reasoning.",
    inputSchema: { snippet: z.string().optional(), repo: z.string().optional(), intent: z.string().optional() },
  }, async ({ snippet, repo, intent }) => {
    const conflicts = await checkConflict({ snippet, repo_id: repo, intent }, ctx);
    return { content: [{ type: "text", text: formatConflictsForAgent(conflicts) }],
             structuredContent: { conflicts } };
  });

  server.registerTool("record_decision", {
    title: "Record a decision",
    description: "Persist a new engineering decision so future code (by any agent or human) respects it.",
    inputSchema: { statement: z.string(), rationale: z.string().optional(), repo: z.string().optional(),
                   scope_globs: z.array(z.string()).optional(), source_url: z.string().optional(), author: z.string().optional() },
  }, async (a) => {
    const d = await recordDecision({ ...a, repo_id: a.repo }, ctx);
    return { content: [{ type: "text", text: `Recorded decision ${d.id}` }], structuredContent: { decision: d } };
  });

  server.registerTool("list_decisions", { /* repo?, status? → listDecisions */ }, /* … */);
  server.registerTool("get_decision",  { /* id → getDecision */ },               /* … */);
  server.registerTool("supersede_decision", { /* id, statement, rationale? */ },  /* … */);

  // Resources: let agents attach the corpus as context.
  server.registerResource("decision", new ResourceTemplate("ares://decisions/{id}", { /* … */ }),
    async (uri, { id }) => ({ contents: [{ uri: uri.href, text: JSON.stringify(await getDecision(id, ctx)) }] }));

  return server;
}
```

**Tool surface (final):** `recall_decisions`, `check_conflict`, `record_decision`, `list_decisions`,
`get_decision`, `supersede_decision`. **Resources:** `ares://decisions/{id}`,
`ares://repo/{repo}/decisions`.

### 7.1 stdio entry — `server/src/mcp/stdio.ts` (bin: `ares-mcp`)

```typescript
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// resolve Ctx from env (ARES_API_URL+ARES_API_KEY → remote core, OR direct DATABASE_URL → local core)
const server = buildMcpServer(ctx);
await server.connect(new StdioServerTransport());
```
Any IDE spawns this; see §14 for client configs. Two modes:
- **Direct**: stdio process talks straight to Postgres + providers (single-user/local dev).
- **Proxy**: stdio process forwards tool calls to a hosted ARES via REST (team/shared corpus). Selected by
  presence of `ARES_API_URL`.

### 7.2 Streamable HTTP mount — `server/src/http/mcp-http.ts`

Stateless mode, mounted at `POST /mcp` (auth via Bearer → workspace, same middleware as REST):
```typescript
app.post("/mcp", apiKeyAuth, async (c) => {
  const ctx = c.get("ctx");
  const server = buildMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  // bridge Hono req/res → transport.handleRequest(...)
});
```

---

## 8. REST API (`server/src/http/routes.ts`)

Thin handlers: `apiKeyAuth` → Zod parse → one core call → JSON. Mirrors the MCP tools for non-MCP clients
(Chrome extension, CI, bots).

| Method & path | Body / query | Core call | Response |
|---|---|---|---|
| `POST /v1/recall` | `{ query, repo?, limit? }` | `recallDecisions` | `{ decisions: ScoredDecision[] }` |
| `POST /v1/check` | `CheckInput` | `checkConflict` | `{ conflicts: Conflict[] }` |
| `POST /v1/decisions` | `RecordInput` | `recordDecision` | `Decision` |
| `GET /v1/decisions` | `?repo=&status=` | `listDecisions` | `{ decisions: Decision[] }` |
| `GET /v1/decisions/:id` | — | `getDecision` | `Decision` \| 404 |
| `POST /v1/decisions/:id/supersede` | `RecordInput` | `supersedeDecision` | `Decision` |
| `DELETE /v1/decisions/:id` | — | `deleteDecision` | 204 |
| `POST /v1/extract` | `{ text }` | `extractDecisions` | `{ candidates: Candidate[] }` |
| `POST /v1/ask` | `{ question, repo?, history? }` | RAG: `recall` → single `generateText` | `{ answer, citations: string[] }` (SSE stream) |
| `POST /v1/overrides` | `{ decision_id, location?, type, actor? }` | insert `overrides` + audit | `{ id }` |
| `GET /v1/health` | — | — | `{ ok: true, version: "2.0.0", db: "up" }` |
| `POST /mcp` | JSON-RPC | MCP Streamable HTTP | per MCP |

`/v1/ask` replaces v1's Durable-Object chat: stateless RAG (recall top-5 → stuff into prompt → stream one
answer with `[decision_id]` citations). `history` (optional) is passed by the client; ARES stores nothing.

---

## 9. Auth & Multi-tenancy (`server/src/http/auth.ts`)

- Token format: `ares_sk_<32 random base62>`. On `POST /admin/keys` (bootstrap/admin), generate token, store
  `sha256(token)` hex + 8-char prefix, return the raw token **once**.
- `apiKeyAuth` middleware: read `Authorization: Bearer ares_sk_…` → `sha256` → `SELECT … FROM api_keys
  WHERE key_hash=$1 AND revoked_at IS NULL` → join workspace → set `c.set("ctx", { db, workspace, config,
  actor })`. Update `last_used_at` (async, fire-and-forget). 401 on miss.
- Every core query filters by `ctx.workspace.id`. No cross-tenant access path exists.
- CORS: allow `https://github.com`, `chrome-extension://*`, and configurable `ALLOWED_ORIGINS`.

---

## 10. Chrome Extension — repointed (demoted to one client)

The extension stays MV3/GitHub but its job narrows to **review-time visualization** of the same substrate.
All Cloudflare assumptions removed; it talks to the ARES REST API configured in the popup.

Message-type renames and endpoint remaps (see §15 for the atomic diffs):

| v1 message | v2 message | endpoint |
|---|---|---|
| `REVIEW` | `CHECK` | `POST /v1/check` |
| `INGEST` | `RECORD` | `POST /v1/decisions` |
| `LIST` | `LIST` | `GET /v1/decisions?repo=` |
| `DELETE` | `DELETE` | `DELETE /v1/decisions/:id` |
| `EXTRACT` | `EXTRACT` | `POST /v1/extract` |
| *(new)* | `RECALL` | `POST /v1/recall` |
| *(new)* | `OVERRIDE` | `POST /v1/overrides` (now persisted) |
| *(chat via DO)* | `ASK` | `POST /v1/ask` (stateless SSE) |

Side panel ("Ask ARES") now streams from `/v1/ask` instead of `/agents/chat/...`. Overrides persist via
`/v1/overrides`. Default API URL becomes `http://localhost:8787` (dev) / configurable hosted URL.

---

## 11. File Tree (Final, v2)

```
ares/
├── README.md                         # rewritten for v2
├── docker-compose.yml                # postgres(pgvector) + server
├── .env.example
├── docs/
│   └── how-pr-flagging-works.html    # KEEP (still accurate for review-time)
├── server/                           # was worker/, fully rewritten
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── migrations/
│   │   ├── 0001_init.sql             # pgvector schema (1536)
│   │   └── 0001_init.local.sql       # halfvec(384) variant for fastembed
│   └── src/
│       ├── index.ts                  # boots Hono(node) + REST + /mcp
│       ├── config.ts
│       ├── db.ts
│       ├── types.ts
│       ├── prompts.ts                # ported from v1
│       ├── providers/
│       │   ├── embeddings.ts
│       │   └── llm.ts
│       ├── core/
│       │   ├── memory.ts
│       │   ├── judge.ts
│       │   ├── extract.ts
│       │   └── review.ts
│       ├── mcp/
│       │   ├── server.ts             # tools + resources
│       │   └── stdio.ts              # bin: ares-mcp
│       ├── http/
│       │   ├── app.ts
│       │   ├── routes.ts
│       │   ├── auth.ts
│       │   └── mcp-http.ts
│       └── scripts/
│           ├── migrate.ts            # runs migrations/*.sql
│           ├── seed.ts               # workspace + API key + demo decisions
│           └── format.ts             # formatDecisionsForAgent/formatConflictsForAgent
├── extension/                        # KEEP, repointed
│   └── src/ (api/background/content/ui/types/popup/selectors/styles)
└── examples/
    ├── cursor-mcp.json
    ├── claude-desktop.json
    └── ci-check.sh
```

---

## 12. Configuration Files

### 12.1 `server/package.json`
```json
{
  "name": "@ares/server",
  "version": "2.0.0",
  "type": "module",
  "bin": { "ares-mcp": "./dist/mcp/stdio.js" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "migrate": "tsx src/scripts/migrate.ts",
    "seed": "tsx src/scripts/seed.ts",
    "mcp": "tsx src/mcp/stdio.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@hono/node-server": "^1.13.0",
    "hono": "^4.6.0",
    "pg": "^8.13.0",
    "pgvector": "^0.2.0",
    "ai": "^4.0.0",
    "@ai-sdk/openai": "^1.0.0",
    "@ai-sdk/anthropic": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "typescript": "^5.5.0",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0"
  }
}
```

### 12.2 `docker-compose.yml`
```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: ares
      POSTGRES_PASSWORD: ares
      POSTGRES_DB: ares
    ports: ["5432:5432"]
    volumes: ["ares_pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ares"]
      interval: 5s
      retries: 10
  server:
    build: ./server
    depends_on:
      db: { condition: service_healthy }
    environment:
      DATABASE_URL: postgres://ares:ares@db:5432/ares
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      LLM_PROVIDER: openai
      EMBED_PROVIDER: openai
      PORT: "8787"
    ports: ["8787:8787"]
    command: sh -c "npm run migrate && npm run start"
volumes: { ares_pgdata: {} }
```

### 12.3 `server/Dockerfile`
Multi-stage: `node:22-alpine` → `npm ci` → `tsc` → run `dist/index.js`.

### 12.4 `server/tsconfig.json`
`module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `outDir: dist`, `types: ["node"]`
(no `@cloudflare/workers-types`).

### 12.5 `.env.example`
```
DATABASE_URL=postgres://ares:ares@localhost:5432/ares
PORT=8787
EMBED_PROVIDER=openai          # openai | local
EMBED_MODEL=text-embedding-3-small
EMBED_DIM=1536
LLM_PROVIDER=openai            # openai | anthropic | ollama
LLM_MODEL=gpt-4o-mini
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
SIMILARITY_THRESHOLD=0.35      # recall pre-filter only; judge LLM is the precision gate (favor recall)
CONFIDENCE_THRESHOLD=0.6
ALLOWED_ORIGINS=https://github.com
```

---

## 13. Prompts (`server/src/prompts.ts`) — ported from v1

`JUDGE_SYSTEM`, `EXTRACT_SYSTEM`, `buildJudgeUserMessage` carry over **unchanged** (they are
provider-neutral). `CHAT_SYSTEM_PROMPT(repoId)` is reused by `/v1/ask`. Add one new helper:

```typescript
export const RECALL_INTENT_HINT =
  "Decisions are imperative team rules. Treat a high-similarity decision as binding context the caller must respect.";
```
And agent-formatting helpers live in `scripts/format.ts`:
- `formatDecisionsForAgent(decisions)` → compact markdown list with `[id]` citations.
- `formatConflictsForAgent(conflicts)` → "⚠ CONFLICT: <statement> — <reasoning> [id]".

---

## 14. Integration Recipes (`examples/`)

### 14.1 Cursor (`examples/cursor-mcp.json` → user's `.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "ares": {
      "command": "npx",
      "args": ["-y", "@ares/server", "ares-mcp"],
      "env": { "ARES_API_URL": "https://ares.yourco.com", "ARES_API_KEY": "ares_sk_..." }
    }
  }
}
```

### 14.2 Claude Desktop (`examples/claude-desktop.json`)
Same shape under `mcpServers`. stdio spawn; proxy mode to hosted ARES.

### 14.3 Remote (Streamable HTTP) — clients that support URL transports
```json
{ "mcpServers": { "ares": { "url": "https://ares.yourco.com/mcp", "headers": { "Authorization": "Bearer ares_sk_..." } } } }
```

### 14.4 CI guardrail (`examples/ci-check.sh`)
`curl POST /v1/check` with the PR diff; non-zero exit if any `confidence >= 0.8` conflict. Drop-in for any CI.

---

## 15. Atomic Migration Plan (v1 → v2) — every edit

This is the build worklist. Each item is independently applicable. Status legend: **DELETE**, **MOVE+REWRITE**,
**MODIFY**, **ADD**.

### 15.1 Deletions (Cloudflare + stale)

| # | Path | Action | Reason |
|---|---|---|---|
| D1 | `ares/worker/wrangler.toml` | **DELETE** | Cloudflare deploy config gone |
| D2 | `ares/worker/src/agents/chat.ts` | **DELETE** | Durable Object chat replaced by stateless `/v1/ask` |
| D3 | `ares/worker/src/agents/` (dir) | **DELETE** | empty after D2 |
| D4 | `ares/worker/schema.sql` | **DELETE** | SQLite/D1 schema replaced by `server/migrations/*.sql` |
| D5 | `ares/worker/package-lock.json` | **DELETE** | regenerated under `server/` |
| D6 | `ares/worker/node_modules/` | **DELETE** | reinstalled under `server/` |
| D7 | `ares/worker/` (dir) | **DELETE** after MOVE items below land in `server/` | renamed to `server/` |

### 15.2 Move + rewrite (worker → server)

| # | From | To | Key changes |
|---|---|---|---|
| M1 | `worker/src/index.ts` | `server/src/index.ts` | Remove `routeAgentRequest`/`export AskARESAgent`. Boot with `@hono/node-server` `serve()`. Mount `app` (REST) + `POST /mcp` (Streamable HTTP). Build `Config` via `loadConfig()`, `Pool` via `makePool()`. |
| M2 | `worker/src/types.ts` | `server/src/types.ts` | Replace `Env` (CF bindings) with `Ctx`/`Config`/`Workspace`. Expand `Decision` (status, rationale, scope_globs, supersedes_id, workspace_id, timestamptz strings). Add `RecordInput`, `RecallOpts`, `CheckInput`. Drop `rowToDecision` D1 shape → add pg row mapper. |
| M3 | `worker/src/memory.ts` | `server/src/core/memory.ts` | Replace `env.DB`(D1)+`env.VECTORIZE` with `ctx.db` (pg). Rewrite all CRUD as parameterized SQL against `decisions`. `embedding` written as `pgvector.toSql(vec)`. Add `recordDecision`/`recallDecisions`/`supersedeDecision`/`deprecateDecision`. `recall` uses §4.2 SQL (single store; no separate vector query + D1 hydrate). Add `writeAudit`. |
| M4 | `worker/src/ai.ts` | split → `server/src/providers/embeddings.ts`, `server/src/providers/llm.ts`, `server/src/core/judge.ts`, `server/src/core/extract.ts` | Remove `env.AI` (Workers AI BGE) → provider `embed`/`embedBatch`. Remove AI Gateway baseURL → `getModel(config)`. Remove `LLM_FALLBACK`/Llama path (provider abstraction covers fallback). Keep `JudgeSchema`/`ExtractSchema`. `judgeConflict`/`extractDecisions` take `ctx`. |
| M5 | `worker/src/routes.ts` | `server/src/http/routes.ts` | Keep Hono. Replace bearer-token-in-env check with `apiKeyAuth` (workspace resolution). Rename/`add` routes per §8 (`/v1/recall`, `/v1/check`, `/v1/decisions[...]`, `/v1/ask`, `/v1/overrides`). `/v1/review`→`/v1/check` (same algorithm, now in `core/review.ts`). Thresholds from `ctx.config`, not module consts. |
| M6 | `worker/src/prompts.ts` | `server/src/prompts.ts` | Port unchanged; add `RECALL_INTENT_HINT`. |
| M7 | `worker/package.json` | `server/package.json` | Remove `wrangler`, `agents`, `@cloudflare/workers-types`. Add `@modelcontextprotocol/sdk`, `pg`, `pgvector`, `@hono/node-server`, `@ai-sdk/anthropic`, `tsx`, `vitest`, `@types/node`, `@types/pg`. New scripts (§12.1). Add `bin: ares-mcp`. |
| M8 | `worker/tsconfig.json` | `server/tsconfig.json` | `NodeNext`, drop workers-types, add `@types/node`. |

### 15.3 Additions (new files)

| # | Path | Purpose |
|---|---|---|
| A1 | `server/migrations/0001_init.sql` | §4.1 schema (1536) |
| A2 | `server/migrations/0001_init.local.sql` | `halfvec(384)` variant for fastembed |
| A3 | `server/src/db.ts` | pg pool + pgvector registration + `ef_search` (§6.1) |
| A4 | `server/src/config.ts` | env→Config, provider selection, thresholds (§6.2) |
| A5 | `server/src/providers/embeddings.ts` | pluggable embed/embedBatch (§6.3) |
| A6 | `server/src/providers/llm.ts` | pluggable getModel (§6.4) |
| A7 | `server/src/core/review.ts` | `checkConflict` pipeline (§5.4) |
| A8 | `server/src/mcp/server.ts` | MCP tools + resources (§7) |
| A9 | `server/src/mcp/stdio.ts` | stdio bin `ares-mcp` (§7.1) |
| A10 | `server/src/http/app.ts` | Hono app + CORS + auth wiring |
| A11 | `server/src/http/auth.ts` | API-key middleware (§9) |
| A12 | `server/src/http/mcp-http.ts` | Streamable HTTP mount (§7.2) |
| A13 | `server/src/scripts/migrate.ts` | apply SQL migrations |
| A14 | `server/src/scripts/seed.ts` | create workspace + API key + 3 demo decisions |
| A15 | `server/src/scripts/format.ts` | agent-facing formatters (§13) |
| A16 | `server/Dockerfile` | multi-stage Node build |
| A17 | `docker-compose.yml` | pgvector + server (§12.2) |
| A18 | `.env.example` | §12.5 |
| A19 | `examples/cursor-mcp.json`, `examples/claude-desktop.json`, `examples/ci-check.sh` | §14 |
| A20 | `README.md` | v2 rewrite (quickstart: `docker compose up`, seed, point Cursor at it) |

### 15.4 Extension edits (in place)

| # | Path | Action | Change |
|---|---|---|---|
| E1 | `extension/src/types.ts` | **MODIFY** | `Decision` += `status`, `rationale`, `scope_globs`. Rework `ExtensionMessage`: `REVIEW`→`CHECK`, `INGEST`→`RECORD`, add `RECALL`, `ASK`, `OVERRIDE`. |
| E2 | `extension/src/background.ts` | **MODIFY** | Remap handlers to §10 endpoints. `CHECK`→`/v1/check`, `RECORD`→`/v1/decisions`, `RECALL`→`/v1/recall`, `ASK`→`/v1/ask` (stream), `OVERRIDE`→`/v1/overrides`. Cache keyed unchanged. |
| E3 | `extension/src/content.ts` | **MODIFY** | Rename `REVIEW` send→`CHECK`. `applyOverride` now also sends `OVERRIDE` message (persist) in addition to client recolor. |
| E4 | `extension/src/ui.ts` | **MODIFY** | Side panel streams from `ASK` (was `/agents/chat/...`). Hover-card override buttons call persisted override. |
| E5 | `extension/manifest.json` | **MODIFY** | `host_permissions`: drop `*.workers.dev`, `gateway.ai.cloudflare.com`; add `http://localhost:8787/*` + leave hosted URL to popup config. |
| E6 | `extension/src/api.ts` | **MODIFY** | `DEFAULT_API_URL` → `http://localhost:8787`. |
| E7 | `extension/src/popup.ts` / `popup.html` | **KEEP** | Health test still `GET /v1/health` (shape unchanged). |

### 15.5 Build order (dependency-safe)

1. A1–A4 (schema, db, config, types via M2) — foundation.
2. A5–A6 providers; M4 (judge/extract) — engine deps.
3. M3 memory; A7 review — core.
4. A11 auth; M5 routes; A10 app — REST.
5. A8–A9, A12 — MCP (stdio + HTTP).
6. M1 index — boot.
7. A13–A15 scripts; A16–A18 infra; M7–M8 manifests.
8. D1–D7 deletions (only after `server/` compiles).
9. E1–E7 extension repoint.
10. A19–A20 examples + README.

---

## 16. Flows

### 16.1 Write-time recall (the core loop — agent, no human)
1. Engineer prompts Cursor: "add response caching to the auth service."
2. Cursor (per its system prompt / ARES tool description) calls **`recall_decisions({ query: "caching auth responses", repo: "demo/demo" })`** via MCP stdio.
3. ARES embeds the query, runs the HNSW cosine search filtered to the workspace+repo, returns the @sarah decision (sim 0.82).
4. The decision text enters Cursor's context. Cursor *doesn't* write the cache — or writes a compliant version — and tells the user why, citing `[decision_id]`.
5. **No PR, no red dot, no human scolded.** The mistake never gets typed.

### 16.2 Conflict check (guardrail, agent or CI)
1. After generating a diff, the agent/CI calls **`check_conflict({ snippet | files, repo })`**.
2. ARES embeds → recalls top-3 → judges with the LLM → returns conflicts (sim>0.75 & conf≥0.6).
3. Agent self-corrects; CI fails the build on high-confidence conflicts.

### 16.3 Record / supersede (corpus growth)
- A reviewer (human or agent) calls **`record_decision`** when a new rule is established.
- When a rule changes, **`supersede_decision`** marks the old `superseded` and links the new one. Recall only
  returns `active`. Audit log captures the lineage.

### 16.4 Review-time (extension, now secondary)
Same as v1 §11.3 but `POST /v1/check`, overrides persisted via `/v1/overrides`, side panel via `/v1/ask`.

---

## 17. Enterprise Considerations (addressing the CTO/investor critique)

| Concern | v2 answer |
|---|---|
| **Lock-in / pricing** | Storing decisions is free and unlimited (corpus = customer's asset & our moat). Meter seats + recall/check volume. No row caps anywhere. |
| **Data residency / air-gap** | Self-host via Docker; `EMBED_PROVIDER=local` + `LLM_PROVIDER=ollama` → zero data leaves the VPC. No Cloudflare/no mandatory SaaS. |
| **Multi-tenancy** | `workspace_id` on every row; API-key→workspace; queries can't cross tenants. |
| **Governance / audit** | `audit_log` append-only (record/recall/check/supersede/override/delete). `overrides` persisted. |
| **Decision lifecycle** | `active/superseded/deprecated` + `supersedes_id` lineage. |
| **Neutrality** | MCP-first; works with any agent/IDE/reviewer. Not tied to GitHub (extension is one client). REST + CI recipe for non-MCP. |
| **Provider risk** | Embeddings + LLM are swappable via env; no single-vendor outage takes the substrate down. |
| **Scale** | Stateless server, HNSW on `halfvec` (50% smaller index), `ef_search` tunable; Postgres scales to millions of decisions per workspace. |

---

## 18. Acceptance Criteria

ARES v2 is ready when all are true:

1. `docker compose up` brings up Postgres+pgvector and the server; `GET /v1/health` returns `{ ok: true, db: "up" }`.
2. `npm run seed` creates a workspace, prints an API key, and ingests 3 demo decisions.
3. `POST /v1/recall { query:"auth caching" }` returns decision #1 with `similarity > 0.6`.
4. `POST /v1/check` with the demo conflicting diff returns ≥1 conflict referencing decision #1, `confidence > 0.6`.
5. **MCP stdio**: pointing Cursor/Claude at `ares-mcp` exposes `recall_decisions`/`check_conflict`/`record_decision`, and calling `recall_decisions` from the agent returns the seeded decision.
6. **MCP Streamable HTTP**: `POST /mcp` initialize + `tools/list` returns the 6 tools.
7. `supersede_decision` flips the old decision to `superseded` (excluded from recall) and links the new one.
8. Extension loads, opens the demo PR, shows a red gutter mark + banner via `/v1/check`; "Override: intentional" persists a row in `overrides`.
9. No Cloudflare dependency remains (`rg -i "wrangler|workers|vectorize|durable|cloudflare"` is clean in `server/`).
10. Switching `LLM_PROVIDER=anthropic` (or `EMBED_PROVIDER=local`) works with no code change.

---

## 19. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Embedding dim mismatch (provider vs `halfvec(1536)`) | Med | High | Assert dim == workspace.embed_dim on every embed; provide `0001_init.local.sql` for 384; fail fast. |
| 2 | HNSW recall misses the seeded decision | Low | High | `ef_search=100`; thresholds tunable via env; seed script runs a recall smoke test. |
| 3 | MCP SDK API drift (modular vs `@modelcontextprotocol/sdk`) | Med | Med | Pin SDK; use stable `@modelcontextprotocol/sdk/server/{mcp,stdio,streamableHttp}.js` import paths. |
| 4 | Agents don't call `recall` proactively | Med | High | Strong tool descriptions ("BEFORE writing code…"); ship a rule snippet for Cursor/Claude in `examples/`. |
| 5 | LLM provider outage during judge | Low | Med | Provider swap via env; `judgeConflict` degrades to `is_conflict:false` rather than erroring the request. |
| 6 | Postgres connection limits under load | Med | Med | Pool `max`, stateless server, pgbouncer note in README. |
| 7 | Cross-tenant data leak | Low | Critical | `workspace_id` filter enforced in every query; integration test asserts isolation. |

---

## 20. Open Decisions to Confirm Before Build

1. **Default embedder dim.** Standardize on 1536 (OpenAI). Confirm, or default to 384 local for true OSS/air-gap-first?
2. **DB client.** `pg` (node-postgres, chosen here) vs `postgres` (porsager). Confirm `pg` for `pgvector` ecosystem maturity.
3. **stdio mode default.** Proxy-to-hosted (team corpus) vs direct-to-Postgres (local). Default = proxy if `ARES_API_URL` set, else direct.
4. **`/v1/ask` history.** Stateless (client passes history) vs persisted thread table. Default stateless.
5. **Admin/key issuance.** CLI `seed` only, or also a `POST /admin/keys` guarded by a root token? Default: both, root token via env.
6. **Monorepo vs single `server` package.** This PRD uses a single `server` package + `extension`. Confirm (vs splitting `core`/`mcp`/`api`).
7. **Keep the Chrome extension at all** for v2, or ship MCP-only first and treat the extension as a later demo artifact?

End of PRD.
