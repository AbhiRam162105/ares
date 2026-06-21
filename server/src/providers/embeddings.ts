import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";
import type { Ctx } from "../types.js";

/**
 * Pluggable, vendor-neutral embeddings (PRD §6.3).
 *
 * Invariant: every returned vector's dimension MUST equal
 * ctx.workspace.embed_dim. We assert this and throw fast on a mismatch so a
 * misconfigured provider can never silently corrupt the halfvec column.
 */

function assertDims(vectors: number[][], ctx: Ctx): void {
  const expected = ctx.workspace.embed_dim;
  for (const vec of vectors) {
    if (vec.length !== expected) {
      throw new Error(
        `embedding dimension mismatch: provider returned ${vec.length}, workspace expects ${expected}`,
      );
    }
  }
}

async function embedOpenAI(texts: string[], ctx: Ctx): Promise<number[][]> {
  const openai = createOpenAI({ apiKey: ctx.config.openaiApiKey });
  const { embeddings } = await embedMany({
    model: openai.embedding(ctx.config.embedModel),
    values: texts,
  });
  return embeddings;
}

async function embedLocal(_texts: string[], _ctx: Ctx): Promise<number[][]> {
  // TODO(fastembed): implement the air-gapped local embedder.
  //   - Use `fastembed` (bge-small-en-v1.5, 384-dim) or transformers.js.
  //   - Requires the halfvec(384) schema variant (migrations/0001_init.local.sql)
  //     and EMBED_DIM=384 / workspace.embed_dim=384.
  //   - Return one number[] per input text, in order.
  // Stubbed until the local dependency is wired up.
  throw new Error(
    "EMBED_PROVIDER=local is not implemented yet. Wire up fastembed (bge-small-en-v1.5, 384-dim) and use migrations/0001_init.local.sql.",
  );
}

export async function embedBatch(texts: string[], ctx: Ctx): Promise<number[][]> {
  if (texts.length === 0) return [];

  const vectors =
    ctx.config.embedProvider === "local"
      ? await embedLocal(texts, ctx)
      : await embedOpenAI(texts, ctx);

  assertDims(vectors, ctx);
  return vectors;
}

export async function embed(text: string, ctx: Ctx): Promise<number[]> {
  const [vec] = await embedBatch([text], ctx);
  return vec;
}
