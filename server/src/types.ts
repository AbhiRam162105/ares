import type { Pool } from "pg";

// ===========================================================================
// Core domain types (PRD §5.5)
// ===========================================================================

export type DecisionStatus = "active" | "superseded" | "deprecated";

export type Decision = {
  id: string;
  workspace_id: string;
  repo_id: string | null;
  scope_globs: string[];
  statement: string;
  rationale: string | null;
  context_code: string | null;
  source_url: string | null;
  author: string | null;
  status: DecisionStatus;
  supersedes_id: string | null;
  embed_model: string;
  created_at: string;
  updated_at: string;
};

export type ScoredDecision = Decision & { similarity: number };

export type Conflict = {
  id: string;
  decision: Decision;
  location: { path: string; start_line: number; end_line: number } | null;
  similarity: number;
  confidence: number;
  reasoning: string;
};

export type JudgeResult = {
  is_conflict: boolean;
  confidence: number;
  reasoning: string;
};

export type Candidate = { text: string; confidence: number };

export type Workspace = {
  id: string;
  name: string;
  embed_model: string;
  embed_dim: number;
};

export type RecordInput = {
  statement: string;
  rationale?: string;
  repo_id?: string;
  scope_globs?: string[];
  context_code?: string;
  source_url?: string;
  author?: string;
  supersedes_id?: string;
};

export type RecallOpts = {
  repo_id?: string;
  limit?: number;
  min_similarity?: number;
};

export type CheckInput = {
  repo_id?: string;
  intent?: string;
  files?: Array<{
    path: string;
    hunks: Array<{ start_line: number; added: string[] }>;
  }>;
  snippet?: string;
};

// ===========================================================================
// Provider / runtime configuration (PRD §6.2)
// ===========================================================================

export type Config = {
  databaseUrl: string;
  embedProvider: "openai" | "local";
  embedModel: string; // default 'text-embedding-3-small'
  embedDim: number; // default 1536
  llmProvider: "openai" | "anthropic" | "ollama";
  llmModel: string; // default 'gpt-4o-mini'
  openaiApiKey?: string;
  anthropicApiKey?: string;
  similarityThreshold: number; // default 0.75
  confidenceThreshold: number; // default 0.6
  githubToken?: string; // for server-side repo bootstrap (review-comment mining)
  port: number;
};

// ===========================================================================
// Request context (PRD §5) — passed as the last arg to every core function.
// ===========================================================================

export type Ctx = {
  db: Pool; // pg pool
  workspace: Workspace; // resolved from API key
  config: Config; // providers, thresholds
  actor?: string; // for audit
};

// ===========================================================================
// pg row -> Decision mapper. The `decisions` table row maps almost 1:1 to the
// Decision type; the embedding column is intentionally excluded.
// ===========================================================================

export type DecisionRow = {
  id: string;
  workspace_id: string;
  repo_id: string | null;
  scope_globs: string[] | null;
  statement: string;
  rationale: string | null;
  context_code: string | null;
  source_url: string | null;
  author: string | null;
  status: DecisionStatus;
  supersedes_id: string | null;
  embed_model: string;
  created_at: Date | string;
  updated_at: Date | string;
  // Present on recall rows; ignored by rowToDecision.
  similarity?: number;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function rowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    repo_id: row.repo_id,
    scope_globs: row.scope_globs ?? [],
    statement: row.statement,
    rationale: row.rationale,
    context_code: row.context_code,
    source_url: row.source_url,
    author: row.author,
    status: row.status,
    supersedes_id: row.supersedes_id,
    embed_model: row.embed_model,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function rowToScoredDecision(row: DecisionRow): ScoredDecision {
  return {
    ...rowToDecision(row),
    similarity: row.similarity ?? 0,
  };
}
