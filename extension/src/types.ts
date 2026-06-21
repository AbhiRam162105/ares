export type DecisionStatus = "active" | "superseded" | "deprecated";

export type Decision = {
  id: string;
  repo_id: string | null;
  // v2 renames v1's `text` field to `statement`.
  statement: string;
  rationale?: string | null;
  scope_globs?: string[];
  status?: DecisionStatus;
  // v2 stores the motivating code under `context_code`; `context_diff` is kept
  // optional for backward compatibility with cached v1 rows.
  context_code?: string | null;
  context_diff?: string | null;
  source_url?: string | null;
  author?: string | null;
  // v1 emitted an epoch-ms number; v2 emits a timestamptz ISO string.
  created_at: number | string;
};

export type Conflict = {
  id: string;
  decision: Decision;
  location: { path: string; start_line: number; end_line: number };
  similarity: number;
  confidence: number;
  reasoning: string;
};

export type ReviewResponse = {
  conflicts: Conflict[];
};

export type ParsedFile = {
  path: string;
  hunks: Array<{ start_line: number; added: string[] }>;
};

export type PageInfo = {
  kind: "pr_files" | "pr_compose" | "other";
  repo_id: string;
  pr_number?: number;
};

export type OverrideType = "intentional" | "accidental";

export type ExtensionMessage =
  // POST /v1/check (CheckInput shape)
  | {
      type: "CHECK";
      payload: {
        repo_id: string;
        intent?: string;
        files: ParsedFile[];
      };
    }
  // POST /v1/extract
  | { type: "EXTRACT"; payload: { text: string; context_diff?: string } }
  // POST /v1/decisions (RecordInput shape)
  | {
      type: "RECORD";
      payload: {
        statement: string;
        rationale?: string;
        repo_id?: string;
        scope_globs?: string[];
        context_code?: string;
        source_url?: string;
        author?: string;
      };
    }
  // POST /v1/recall
  | { type: "RECALL"; payload: { query: string; repo_id?: string; limit?: number } }
  // POST /v1/ask (stateless RAG; streamed text handled as plain fetch for now)
  | {
      type: "ASK";
      payload: {
        question: string;
        repo_id?: string;
        history?: Array<{ role: "user" | "assistant"; content: string }>;
      };
    }
  // POST /v1/overrides (now persisted server-side)
  | {
      type: "OVERRIDE";
      payload: {
        decision_id: string;
        location?: { path: string; start_line: number; end_line: number };
        type: OverrideType;
        actor?: string;
      };
    }
  // GET /v1/decisions?repo=
  | { type: "LIST"; payload: { repo_id: string } }
  // DELETE /v1/decisions/:id
  | { type: "DELETE"; payload: { id: string } }
  // GET /v1/health
  | { type: "HEALTH" };
