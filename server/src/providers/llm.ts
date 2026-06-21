import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV1 } from "ai";
import type { Config } from "../types.js";

/**
 * Resolve a provider-agnostic chat model from config (PRD §6.4). No AI Gateway,
 * no Cloudflare baseURL — the provider's default endpoint (or its standard env
 * override, e.g. OPENAI_BASE_URL) is used.
 *
 * - openai    -> @ai-sdk/openai
 * - anthropic -> @ai-sdk/anthropic
 * - ollama    -> OpenAI-compatible provider pointed at the local Ollama server
 */
export function getModel(config: Config): LanguageModelV1 {
  switch (config.llmProvider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });
      return anthropic(config.llmModel);
    }
    case "ollama": {
      const ollama = createOpenAI({
        baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
        apiKey: "ollama", // ignored by Ollama but required by the client
      });
      return ollama(config.llmModel);
    }
    default: {
      const openai = createOpenAI({ apiKey: config.openaiApiKey });
      return openai(config.llmModel);
    }
  }
}
