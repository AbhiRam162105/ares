export { selectors } from "./selectors";

import type {
  Conflict,
  OverrideType,
  PageInfo,
  ParsedFile,
  ReviewResponse,
} from "./types";
import {
  closeSidePanel,
  injectAresButton,
  openSidePanel,
  renderBanner,
  renderConflicts,
  resetUi,
  setOverrideHandler,
} from "./ui";
import { selectors } from "./selectors";

type Hunk = { start_line: number; added: string[] };

let lastUrl = "";
const conflictMap = new Map<string, Conflict>();

export function detectPage(): PageInfo | null {
  const path = location.pathname;

  const filesMatch = path.match(
    /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)$/,
  );
  if (filesMatch) {
    const [, owner, repo, pr] = filesMatch;
    return {
      kind: "pr_files",
      repo_id: `${owner}/${repo}`.toLowerCase(),
      pr_number: parseInt(pr, 10),
    };
  }

  const composeMatch = path.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  if (composeMatch) {
    const [, owner, repo, pr] = composeMatch;
    return {
      kind: "pr_compose",
      repo_id: `${owner}/${repo}`.toLowerCase(),
      pr_number: parseInt(pr, 10),
    };
  }

  const newPrMatch = path.match(/^\/([^/]+)\/([^/]+)\/compare\//);
  if (newPrMatch) {
    const [, owner, repo] = newPrMatch;
    return {
      kind: "pr_compose",
      repo_id: `${owner}/${repo}`.toLowerCase(),
    };
  }

  const repoMatch = path.match(/^\/([^/]+)\/([^/]+)/);
  if (repoMatch) {
    const [, owner, repo] = repoMatch;
    return {
      kind: "other",
      repo_id: `${owner}/${repo}`.toLowerCase(),
    };
  }

  return null;
}

function cleanFilePath(text: string): string {
  // Strip zero-width spaces / left-to-right marks that GitHub wraps file
  // names with for accessibility, plus trim whitespace.
  return text.replace(/[​-‏﻿]/g, "").trim();
}

export function parseDiff(): ParsedFile[] {
  try {
    const rawBlocks = Array.from(document.querySelectorAll(selectors.fileBlock));
    // Some selectors overlap (a parent and a child may both match). Keep the
    // deepest match per file so we don't process the same file twice.
    const seenPaths = new Set<string>();
    const files: ParsedFile[] = [];

    for (const block of rawBlocks) {
      const pathEl = block.querySelector(selectors.filePath);
      if (!pathEl) continue;
      const rawPath =
        pathEl.getAttribute("title") ?? pathEl.textContent ?? "";
      const path = cleanFilePath(rawPath);
      if (!path || seenPaths.has(path)) continue;
      seenPaths.add(path);

      const rows = block.querySelectorAll(selectors.diffRowAlt);
      const hunks: Hunk[] = [];
      let current: Hunk | null = null;

      for (const row of rows) {
        if (selectors.isHunkHeader(row)) {
          if (current) {
            hunks.push(current);
            current = null;
          }
          continue;
        }
        if (!selectors.isAddition(row)) {
          if (current) {
            hunks.push(current);
            current = null;
          }
          continue;
        }
        const lineCell = row.querySelector(selectors.newLineCell);
        const lineNum = parseInt(
          lineCell?.getAttribute(selectors.newLineNumberAttr) ?? "0",
          10,
        );
        if (!lineNum) continue;
        const codeEl = row.querySelector(selectors.codeContent);
        const text = (codeEl?.textContent ?? "").replace(/^\+/, "");

        if (!current) current = { start_line: lineNum, added: [] };
        current.added.push(text);
      }
      if (current) hunks.push(current);
      if (hunks.length) files.push({ path, hunks });
    }
    return files;
  } catch (err) {
    console.warn("[ARES] parseDiff failed:", err);
    return [];
  }
}

export async function requestReview(
  files: ParsedFile[],
  page: PageInfo,
): Promise<ReviewResponse> {
  const response = await chrome.runtime.sendMessage({
    type: "CHECK",
    payload: {
      repo_id: page.repo_id,
      files,
    },
  });

  if (!response?.ok) {
    throw new Error(response?.error ?? "Check request failed");
  }
  return response.data as ReviewResponse;
}

// Recolor the conflict marker client-side AND persist the override via
// POST /v1/overrides so enterprise governance has an audit trail.
export function applyOverride(conflictId: string, type: OverrideType): void {
  const mark = document.querySelector(`[data-conflict-id="${conflictId}"]`);
  if (mark instanceof HTMLElement) {
    mark.classList.remove("ares-gutter-intentional", "ares-gutter-accidental");
    mark.classList.add(
      type === "intentional" ? "ares-gutter-intentional" : "ares-gutter-accidental",
    );
    mark.setAttribute("title", `ARES override: ${type}`);
  }

  const conflict = conflictMap.get(conflictId);
  if (!conflict) return;

  void chrome.runtime.sendMessage({
    type: "OVERRIDE",
    payload: {
      decision_id: conflict.decision.id,
      location: conflict.location,
      type,
    },
  });
}

function buildHunkLookup(files: ParsedFile[]): (path: string, startLine: number) => string[] | null {
  const map = new Map<string, string[]>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      map.set(`${file.path}|${hunk.start_line}`, hunk.added);
    }
  }
  return (path: string, startLine: number) => {
    // Exact match first.
    const exact = map.get(`${path}|${startLine}`);
    if (exact) return exact;
    // Otherwise find the hunk that contains startLine.
    for (const file of files) {
      if (file.path !== path) continue;
      for (const hunk of file.hunks) {
        const last = hunk.start_line + hunk.added.length - 1;
        if (startLine >= hunk.start_line && startLine <= last) return hunk.added;
      }
    }
    return null;
  };
}

async function parseDiffWithRetry(maxAttempts = 20, intervalMs = 500): Promise<ParsedFile[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const files = parseDiff();
    if (files.length > 0 && files.some((f) => f.hunks.length > 0)) {
      if (attempt > 0) {
        console.log(`[ARES] diff appeared after ${attempt * intervalMs}ms (attempt ${attempt + 1})`);
      }
      return files;
    }
    if (attempt === 0) {
      console.log("[ARES] waiting for diff DOM to hydrate...");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return [];
}

async function runReview(page: PageInfo): Promise<void> {
  const files = await parseDiffWithRetry();
  console.log("[ARES] parseDiff →", files.length, "file(s),", files.map(f => `${f.path}:${f.hunks.length}h`));
  if (!files.length) {
    console.warn("[ARES] no hunks parsed after retries — DOM selectors may be stale.");
    return;
  }

  try {
    const response = await requestReview(files, page);
    console.log("[ARES] review →", response.conflicts.length, "conflict(s)", response.conflicts);
    conflictMap.clear();
    for (const conflict of response.conflicts) {
      conflictMap.set(conflict.id, conflict);
    }
    if (response.conflicts.length) {
      renderBanner(response.conflicts.length, response.conflicts);
      renderConflicts(response.conflicts, buildHunkLookup(files));
    }
  } catch (err) {
    console.warn("[ARES] review failed:", err);
  }
}

function mountHeaderButton(page: PageInfo): void {
  const header = document.querySelector(selectors.prHeader);
  if (!header || header.querySelector(".ares-header-btn")) return;

  injectAresButton(header, () => {
    openSidePanel(page.repo_id);
  });
}

async function bootstrap(): Promise<void> {
  resetUi();
  conflictMap.clear();
  closeSidePanel();

  const page = detectPage();
  console.log("[ARES] bootstrap on", location.pathname, "→", page);
  if (!page) return;

  mountHeaderButton(page);

  if (page.kind === "pr_files") {
    await runReview(page);
  }
}

function onUrlChange(): void {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  void bootstrap();
}

function init(): void {
  lastUrl = location.href;
  setOverrideHandler(applyOverride);
  void bootstrap();

  window.addEventListener("popstate", onUrlChange);

  const observer = new MutationObserver(onUrlChange);
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

export { openSidePanel, closeSidePanel };
