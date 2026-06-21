export type Settings = {
  apiUrl: string;
  token: string;
};

const DEFAULT_API_URL = "http://localhost:8787";

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(["apiUrl", "token"]);
  return {
    apiUrl: (stored.apiUrl as string | undefined) ?? DEFAULT_API_URL,
    token: (stored.token as string | undefined) ?? "",
  };
}

async function call(method: string, path: string, body?: unknown) {
  const { apiUrl, token } = await getSettings();
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

// Returns the raw response body as text. Used by /v1/ask, which streams an SSE
// answer; for now we read it as a single text blob (no incremental rendering).
async function callText(method: string, path: string, body?: unknown): Promise<string> {
  const { apiUrl, token } = await getSettings();
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.text();
}

export const api = {
  get: (p: string) => call("GET", p),
  post: (p: string, b: unknown) => call("POST", p, b),
  postText: (p: string, b: unknown) => callText("POST", p, b),
  delete: (p: string) => call("DELETE", p),
};
