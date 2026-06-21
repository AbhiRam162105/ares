import { RECALL_INTENT_HINT } from "../prompts.js";
import type { Conflict, ScoredDecision } from "../types.js";

/**
 * Compact markdown rendering of recalled decisions for an agent's context
 * window (PRD §13). Each line carries an [id] citation the agent should echo.
 */
export function formatDecisionsForAgent(decisions: ScoredDecision[]): string {
  if (decisions.length === 0) {
    return "No relevant team decisions found.";
  }

  const lines = decisions.map((d) => {
    const sim = d.similarity.toFixed(2);
    const scope = d.repo_id ? ` (${d.repo_id})` : "";
    const why = d.rationale ? ` — ${d.rationale}` : "";
    return `- [${d.id}] (sim ${sim})${scope} ${d.statement}${why}`;
  });

  return `${RECALL_INTENT_HINT}\n\n${lines.join("\n")}`;
}

/**
 * Compact markdown rendering of conflicts for an agent (PRD §13):
 * "⚠ CONFLICT: <statement> — <reasoning> [id]".
 */
export function formatConflictsForAgent(conflicts: Conflict[]): string {
  if (conflicts.length === 0) {
    return "No conflicts with past decisions.";
  }

  return conflicts
    .map((c) => {
      const loc = c.location
        ? ` @ ${c.location.path}:${c.location.start_line}-${c.location.end_line}`
        : "";
      const conf = c.confidence.toFixed(2);
      return `⚠ CONFLICT (conf ${conf})${loc}: ${c.decision.statement} — ${c.reasoning} [${c.decision.id}]`;
    })
    .join("\n");
}
