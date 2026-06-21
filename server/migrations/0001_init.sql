-- Idempotent: safe to re-run (the container runs `migrate` on every boot).
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector 0.8+
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- A team/org. Owns everything below it.
CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  embed_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  embed_dim   INTEGER NOT NULL DEFAULT 1536,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys map a bearer token to a workspace. Store only the hash.
CREATE TABLE IF NOT EXISTS api_keys (
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
DO $$ BEGIN
  CREATE TYPE decision_status AS ENUM ('active', 'superseded', 'deprecated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS decisions (
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

CREATE INDEX IF NOT EXISTS idx_decisions_workspace ON decisions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_decisions_repo      ON decisions(workspace_id, repo_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status    ON decisions(workspace_id, status);

-- Vector index: HNSW + halfvec + cosine. Query MUST use <=> and ::halfvec(1536).
CREATE INDEX IF NOT EXISTS idx_decisions_embedding ON decisions
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Persisted overrides (enterprise governance; v1 was client-only).
DO $$ BEGIN
  CREATE TYPE override_type AS ENUM ('intentional', 'accidental');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS overrides (
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
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor        TEXT,
  action       TEXT NOT NULL,                  -- 'record'|'recall'|'check'|'supersede'|'override'|'delete'
  decision_id  UUID,
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_log(workspace_id, created_at DESC);
