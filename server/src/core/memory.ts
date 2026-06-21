import pgvector from "pgvector/pg";
import { embed } from "../providers/embeddings.js";
import {
  rowToDecision,
  rowToScoredDecision,
  type Ctx,
  type Decision,
  type DecisionRow,
  type DecisionStatus,
  type RecallOpts,
  type RecordInput,
  type ScoredDecision,
} from "../types.js";

// Every non-embedding column, used for RETURNING / SELECT so we never ship the
// (large) embedding back to callers.
const COLS = `id, workspace_id, repo_id, scope_globs, statement, rationale,
  context_code, source_url, author, status, supersedes_id, embed_model,
  created_at, updated_at`;

/**
 * Append a row to the governance audit trail. Best-effort context only — the
 * caller's `actor` is taken from ctx.
 */
export async function writeAudit(
  ctx: Ctx,
  action: string,
  decisionId: string | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO audit_log (workspace_id, actor, action, decision_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      ctx.workspace.id,
      ctx.actor ?? null,
      action,
      decisionId,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
}

/**
 * Store a new decision (metadata + embedding) in one Postgres row (PRD §5.1).
 */
export async function recordDecision(
  input: RecordInput,
  ctx: Ctx,
): Promise<Decision> {
  const vec = await embed(
    `${input.statement}\n${input.rationale ?? ""}\n${input.context_code ?? ""}`,
    ctx,
  );

  const dim = ctx.workspace.embed_dim;
  const repoId = input.repo_id ? input.repo_id.toLowerCase() : null;

  const { rows } = await ctx.db.query(
    `INSERT INTO decisions
       (workspace_id, repo_id, scope_globs, statement, rationale, context_code,
        source_url, author, supersedes_id, embedding, embed_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::halfvec(${dim}), $11)
     RETURNING ${COLS}`,
    [
      ctx.workspace.id,
      repoId,
      input.scope_globs ?? [],
      input.statement,
      input.rationale ?? null,
      input.context_code ?? null,
      input.source_url ?? null,
      input.author ?? null,
      input.supersedes_id ?? null,
      pgvector.toSql(vec),
      ctx.workspace.embed_model,
    ],
  );

  const decision = rowToDecision(rows[0] as DecisionRow);
  await writeAudit(ctx, "record", decision.id);
  return decision;
}

/**
 * The write-time call: semantic search over the workspace's active decisions
 * (PRD §5.1 + §4.2 recall SQL). Always filters by workspace_id.
 */
export async function recallDecisions(
  query: string,
  opts: RecallOpts,
  ctx: Ctx,
): Promise<ScoredDecision[]> {
  const limit = opts.limit ?? 5;
  const minSimilarity = opts.min_similarity ?? 0.3;
  const repoId = opts.repo_id ? opts.repo_id.toLowerCase() : null;
  const dim = ctx.workspace.embed_dim;

  const vec = await embed(query, ctx);

  const { rows } = await ctx.db.query(
    `SELECT ${COLS}, 1 - (embedding <=> $1::halfvec(${dim})) AS similarity
       FROM decisions
      WHERE workspace_id = $2
        AND status = 'active'
        AND ($3::text IS NULL OR repo_id = $3 OR repo_id IS NULL)
      ORDER BY embedding <=> $1::halfvec(${dim})
      LIMIT $4`,
    [pgvector.toSql(vec), ctx.workspace.id, repoId, limit],
  );

  const results = (rows as DecisionRow[])
    .map(rowToScoredDecision)
    .filter((d) => d.similarity >= minSimilarity);

  await writeAudit(ctx, "recall", null, { query, n: results.length });
  return results;
}

export async function getDecision(
  id: string,
  ctx: Ctx,
): Promise<Decision | null> {
  const { rows } = await ctx.db.query(
    `SELECT ${COLS} FROM decisions WHERE id = $1 AND workspace_id = $2`,
    [id, ctx.workspace.id],
  );
  return rows.length ? rowToDecision(rows[0] as DecisionRow) : null;
}

export async function listDecisions(
  filter: { repo_id?: string; status?: DecisionStatus },
  ctx: Ctx,
): Promise<Decision[]> {
  const conditions = ["workspace_id = $1"];
  const params: unknown[] = [ctx.workspace.id];

  if (filter.repo_id !== undefined) {
    params.push(filter.repo_id.toLowerCase());
    conditions.push(`repo_id = $${params.length}`);
  }
  if (filter.status !== undefined) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }

  const { rows } = await ctx.db.query(
    `SELECT ${COLS} FROM decisions
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC`,
    params,
  );
  return (rows as DecisionRow[]).map(rowToDecision);
}

/**
 * Mark an existing decision superseded and record its replacement, linked via
 * supersedes_id, in a single transaction (PRD §5.1).
 */
export async function supersedeDecision(
  id: string,
  input: RecordInput,
  ctx: Ctx,
): Promise<Decision> {
  const client = await ctx.db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE decisions
          SET status = 'superseded', updated_at = now()
        WHERE id = $1 AND workspace_id = $2`,
      [id, ctx.workspace.id],
    );

    // Embed + insert the replacement inside the same transaction.
    const vec = await embed(
      `${input.statement}\n${input.rationale ?? ""}\n${input.context_code ?? ""}`,
      ctx,
    );
    const dim = ctx.workspace.embed_dim;
    const repoId = input.repo_id ? input.repo_id.toLowerCase() : null;

    const { rows } = await client.query(
      `INSERT INTO decisions
         (workspace_id, repo_id, scope_globs, statement, rationale, context_code,
          source_url, author, supersedes_id, embedding, embed_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::halfvec(${dim}), $11)
       RETURNING ${COLS}`,
      [
        ctx.workspace.id,
        repoId,
        input.scope_globs ?? [],
        input.statement,
        input.rationale ?? null,
        input.context_code ?? null,
        input.source_url ?? null,
        input.author ?? null,
        id,
        pgvector.toSql(vec),
        ctx.workspace.embed_model,
      ],
    );

    await client.query("COMMIT");
    const decision = rowToDecision(rows[0] as DecisionRow);
    await writeAudit(ctx, "supersede", decision.id, { supersedes_id: id });
    return decision;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deprecateDecision(id: string, ctx: Ctx): Promise<void> {
  await ctx.db.query(
    `UPDATE decisions
        SET status = 'deprecated', updated_at = now()
      WHERE id = $1 AND workspace_id = $2`,
    [id, ctx.workspace.id],
  );
  await writeAudit(ctx, "deprecate", id);
}

export async function deleteDecision(id: string, ctx: Ctx): Promise<void> {
  await ctx.db.query(
    `DELETE FROM decisions WHERE id = $1 AND workspace_id = $2`,
    [id, ctx.workspace.id],
  );
  await writeAudit(ctx, "delete", id);
}
