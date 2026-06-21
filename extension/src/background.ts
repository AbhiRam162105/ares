import { api } from "./api";
import type { Decision, ExtensionMessage, ReviewResponse } from "./types";

type CacheEntry = { decision: Decision; expires: number };

const decisionCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function cacheGet(id: string): Decision | null {
  const entry = decisionCache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    decisionCache.delete(id);
    return null;
  }
  return entry.decision;
}

function cacheSet(decision: Decision): void {
  decisionCache.set(decision.id, {
    decision,
    expires: Date.now() + CACHE_TTL_MS,
  });
}

function evictExpired(): void {
  const now = Date.now();
  for (const [id, entry] of decisionCache) {
    if (now > entry.expires) decisionCache.delete(id);
  }
}

async function handleMessage(message: ExtensionMessage): Promise<unknown> {
  switch (message.type) {
    case "CHECK":
      return api.post("/v1/check", message.payload);

    case "EXTRACT":
      return api.post("/v1/extract", message.payload);

    case "RECORD":
      return api.post("/v1/decisions", message.payload);

    case "RECALL":
      return api.post("/v1/recall", message.payload);

    case "ASK": {
      // /v1/ask streams an SSE answer; for now we read it as a single text blob.
      const answer = await api.postText("/v1/ask", message.payload);
      return { answer };
    }

    case "OVERRIDE":
      return api.post("/v1/overrides", message.payload);

    case "LIST": {
      const { repo_id } = message.payload;
      const params = new URLSearchParams({ repo: repo_id });
      const result = await api.get(`/v1/decisions?${params.toString()}`);
      if (result && typeof result === "object" && "decisions" in result) {
        const decisions = (result as { decisions: Decision[] }).decisions;
        if (Array.isArray(decisions)) {
          for (const d of decisions) {
            cacheSet(d);
          }
        }
      }
      return result;
    }

    case "DELETE":
      await api.delete(`/v1/decisions/${message.payload.id}`);
      decisionCache.delete(message.payload.id);
      return { ok: true };

    case "HEALTH":
      return api.get("/v1/health");

    default:
      throw new Error("Unknown message type");
  }
}

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    evictExpired();

    handleMessage(message)
      .then((result) => {
        if (message.type === "CHECK" && result && typeof result === "object") {
          // Cast through ReviewResponse from types.ts to ensure the nested
          // Decision shape matches the canonical type used elsewhere.
          const review = result as Partial<ReviewResponse>;
          const conflicts = review.conflicts;
          if (Array.isArray(conflicts)) {
            for (const c of conflicts) {
              if (c && c.decision && typeof c.decision.id === "string") {
                cacheSet(c.decision satisfies Decision);
              }
            }
          }
        }
        sendResponse({ ok: true, data: result });
      })
      .catch((err: Error) => {
        sendResponse({ ok: false, error: err.message });
      });

    return true;
  },
);

export { cacheGet, cacheSet };
