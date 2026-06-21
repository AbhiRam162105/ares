import { getSettings } from "./api";

const DEFAULT_API_URL = "https://ares.workers.dev";

const apiUrlInput = document.getElementById("apiUrl") as HTMLInputElement;
const tokenInput = document.getElementById("token") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const toastEl = document.getElementById("toast") as HTMLDivElement;
const testBtn = document.getElementById("test-btn") as HTMLButtonElement;
const form = document.getElementById("settings-form") as HTMLFormElement;

function setStatus(message: string, ok: boolean | null): void {
  statusEl.textContent = message;
  statusEl.className = "ares-popup-status";
  if (ok === true) statusEl.classList.add("ok");
  if (ok === false) statusEl.classList.add("err");
}

function showToast(message: string): void {
  toastEl.textContent = message;
  setTimeout(() => {
    toastEl.textContent = "";
  }, 3000);
}

function validateApiUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "API URL is required" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Invalid URL format" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "URL must use http or https" };
  }
  // Strip trailing slash for clean concatenation with /v1/...
  const normalized = trimmed.replace(/\/+$/, "");
  return { ok: true, url: normalized };
}

async function loadSettings(): Promise<void> {
  const { apiUrl, token } = await getSettings();
  apiUrlInput.value = apiUrl || DEFAULT_API_URL;
  tokenInput.value = token;
}

async function saveSettings(): Promise<void> {
  const validation = validateApiUrl(apiUrlInput.value);
  if (!validation.ok) {
    setStatus(`✗ ${validation.error}`, false);
    return;
  }
  await chrome.storage.sync.set({
    apiUrl: validation.url,
    token: tokenInput.value.trim(),
  });
  apiUrlInput.value = validation.url;
  showToast("ARES connected.");
}

async function testConnection(): Promise<void> {
  const validation = validateApiUrl(apiUrlInput.value);
  if (!validation.ok) {
    setStatus(`✗ ${validation.error}`, false);
    return;
  }
  const apiUrl = validation.url;
  const token = tokenInput.value.trim();

  setStatus("Testing…", null);

  try {
    const res = await fetch(`${apiUrl}/v1/health`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      setStatus("✓ Connected", true);
    } else {
      const body = await res.text().catch(() => "");
      setStatus(`✗ ${res.status} ${body || "Connection failed"}`, false);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    setStatus(`✗ ${message}`, false);
  }
}

testBtn.addEventListener("click", () => void testConnection());

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void saveSettings();
});

void loadSettings();
