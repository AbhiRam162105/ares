import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "../providers/llm.js";
import { EXTRACT_SYSTEM } from "../prompts.js";
import type { Candidate, Ctx } from "../types.js";

export const ExtractSchema = z.object({
  decisions: z.array(
    z.object({
      text: z
        .string()
        .describe("the imperative engineering decision, one sentence"),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

/**
 * Extract candidate engineering decisions from free text (PRD §5.3).
 * On any throw it returns [] so callers never have to handle an error.
 */
export async function extractDecisions(
  text: string,
  ctx: Ctx,
): Promise<Candidate[]> {
  try {
    const { object } = await generateObject({
      model: getModel(ctx.config),
      schema: ExtractSchema,
      system: EXTRACT_SYSTEM,
      prompt: text,
    });
    return object.decisions;
  } catch (error) {
    console.error("extractDecisions failed", error);
    return [];
  }
}
