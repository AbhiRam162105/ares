import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "../providers/llm.js";
import { JUDGE_SYSTEM, buildJudgeUserMessage } from "../prompts.js";
import type { Ctx, Decision, JudgeResult } from "../types.js";

export const JudgeSchema = z.object({
  is_conflict: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z
    .string()
    .max(200)
    .describe("one short sentence explaining the verdict"),
});

/**
 * Judge whether a code hunk conflicts with a past decision (PRD §5.2).
 * Provider-agnostic via getModel(ctx.config). Degrades gracefully: on any
 * throw it returns a non-conflict verdict so the request never errors out.
 */
export async function judgeConflict(
  decision: Decision,
  hunk: string,
  ctx: Ctx,
): Promise<JudgeResult> {
  try {
    const { object } = await generateObject({
      model: getModel(ctx.config),
      schema: JudgeSchema,
      system: JUDGE_SYSTEM,
      prompt: buildJudgeUserMessage(decision, hunk),
    });
    return object;
  } catch (error) {
    console.error("judgeConflict failed", error);
    return { is_conflict: false, confidence: 0, reasoning: "judge_failed" };
  }
}
