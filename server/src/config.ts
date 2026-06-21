import type { Config } from "./types.js";

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pick<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Reads env once, selects providers, exposes thresholds (PRD §6.2).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL ?? "";

  return {
    databaseUrl,
    embedProvider: pick(env.EMBED_PROVIDER, ["openai", "local"] as const, "openai"),
    embedModel: env.EMBED_MODEL ?? "text-embedding-3-small",
    embedDim: num(env.EMBED_DIM, 1536),
    llmProvider: pick(
      env.LLM_PROVIDER,
      ["openai", "anthropic", "ollama"] as const,
      "openai",
    ),
    llmModel: env.LLM_MODEL ?? "gpt-4o-mini",
    openaiApiKey: env.OPENAI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    // 0.35: this is only the cheap RECALL pre-filter — the judge LLM is the
    // precision gate, so a memory guardrail should favor recall (don't miss a
    // real conflict) over precision here. With text-embedding-3-small,
    // equivalent code-vs-prose pairs score ~0.35-0.55 cosine; intent-blended
    // checks land higher. Raise for higher-dim models / cost-sensitive setups.
    // See ARES_V2_PRD §19 risk #4.
    similarityThreshold: num(env.SIMILARITY_THRESHOLD, 0.35),
    confidenceThreshold: num(env.CONFIDENCE_THRESHOLD, 0.6),
    githubToken: env.GITHUB_TOKEN || env.GH_TOKEN || undefined,
    port: num(env.PORT, 8787),
  };
}
