import { randomUUID } from "node:crypto";
import pgvector from "pgvector/pg";
import { embedBatch } from "../providers/embeddings.js";
import { judgeConflict } from "./judge.js";
import { writeAudit } from "./memory.js";
import {
  rowToDecision,
  type CheckInput,
  type Conflict,
  type Ctx,
  type Decision,
  type DecisionRow,
} from "../types.js";

const COLS = `id, workspace_id, repo_id, scope_globs, statement, rationale,
  context_code, source_url, author, status, supersedes_id, embed_model,
  created_at, updated_at`;

const RECALL_TOP_K = 3;

type ChunkLoc = { path: string; start_line: number; end_line: number } | null;

type Candidate = {
  decision: Decision;
  chunk_idx: number;
  similarity: number;
};

/**
 * The guardrail (PRD §5.4): given new code (snippet or files+hunks) and an
 * optional intent, return the decisions it conflicts with. Always scoped to
 * ctx.workspace via the recall SQL.
 */
export async function checkConflict(
  input: CheckInput,
  ctx: Ctx,
): Promise<Conflict[]> {
  // 1. Build chunks[] + chunkLocs[] (one per hunk; snippet mode = one chunk).
  // When an `intent` is supplied (the agent's natural-language description of
  // what it's doing), blend it into the embedded text. Raw code embeds poorly
  // against terse prose decisions (~0.35 cosine); the intent lifts recall to
  // the prose-vs-prose range (~0.55) where real conflicts surface.
  const chunks: string[] = [];
  const chunkLocs: ChunkLoc[] = [];
  const intentPrefix = input.intent ? `Intent: ${input.intent}\n` : "";

  if (input.files && input.files.length > 0) {
    for (const file of input.files) {
      for (const hunk of file.hunks) {
        if (hunk.added.length === 0) continue;
        chunks.push(`${intentPrefix}file: ${file.path}\n${hunk.added.join("\n")}`);
        chunkLocs.push({
          path: file.path,
          start_line: hunk.start_line,
          end_line: hunk.start_line + hunk.added.length - 1,
        });
      }
    }
  } else if (input.snippet) {
    chunks.push(`${intentPrefix}${input.snippet}`);
    chunkLocs.push(null);
  }

  if (chunks.length === 0) {
    await writeAudit(ctx, "check", null, { conflicts: 0 });
    return [];
  }

  // 2. Embed every chunk in one batch.
  const embeddings = await embedBatch(chunks, ctx);

  // 3. Recall topK per chunk (active, repo-scoped); keep > similarityThreshold.
  //    4. Dedupe by decision_id, keeping the best-similarity chunk.
  const repoId = input.repo_id ? input.repo_id.toLowerCase() : null;
  const dim = ctx.workspace.embed_dim;
  const bestByDecision = new Map<string, Candidate>();

  await Promise.all(
    embeddings.map(async (embedding, chunkIdx) => {
      const { rows } = await ctx.db.query(
        `SELECT ${COLS}, 1 - (embedding <=> $1::halfvec(${dim})) AS similarity
           FROM decisions
          WHERE workspace_id = $2
            AND status = 'active'
            AND ($3::text IS NULL OR repo_id = $3 OR repo_id IS NULL)
          ORDER BY embedding <=> $1::halfvec(${dim})
          LIMIT $4`,
        [pgvector.toSql(embedding), ctx.workspace.id, repoId, RECALL_TOP_K],
      );

      for (const row of rows as DecisionRow[]) {
        const similarity = row.similarity ?? 0;
        if (similarity <= ctx.config.similarityThreshold) continue;

        const existing = bestByDecision.get(row.id);
        if (!existing || similarity > existing.similarity) {
          bestByDecision.set(row.id, {
            decision: rowToDecision(row),
            chunk_idx: chunkIdx,
            similarity,
          });
        }
      }
    }),
  );

  // 5. Judge each survivor in parallel; discard non-conflicts / low confidence.
  const judged = await Promise.all(
    [...bestByDecision.values()].map(async (candidate) => {
      const judge = await judgeConflict(
        candidate.decision,
        chunks[candidate.chunk_idx],
        ctx,
      );

      if (!judge.is_conflict || judge.confidence < ctx.config.confidenceThreshold) {
        return null;
      }

      const conflict: Conflict = {
        id: randomUUID(),
        decision: candidate.decision,
        location: chunkLocs[candidate.chunk_idx],
        similarity: candidate.similarity,
        confidence: judge.confidence,
        reasoning: judge.reasoning,
      };
      return conflict;
    }),
  );

  const conflicts = judged.filter((c): c is Conflict => c !== null);

  // 6. Audit.
  await writeAudit(ctx, "check", null, { conflicts: conflicts.length });

  // 7. Return.
  return conflicts;
}
