import { selectors } from "./selectors";
import type { Conflict, OverrideType } from "./types";

export type HunkLookup = (path: string, startLine: number) => string[] | null;
export type OverrideHandler = (conflictId: string, type: OverrideType) => void;

let activeCard: HTMLElement | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let panelEl: HTMLElement | null = null;
let bannerEl: HTMLElement | null = null;

// content.ts registers the persisted-override handler here so hover-card
// buttons can both recolor the marker and POST /v1/overrides.
let overrideHandler: OverrideHandler | null = null;
export function setOverrideHandler(handler: OverrideHandler): void {
  overrideHandler = handler;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(value: number | string): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

function getLineNumber(row: Element): number {
  const lineCell = row.querySelector(selectors.newLineCell);
  return parseInt(
    lineCell?.getAttribute(selectors.newLineNumberAttr) ?? "0",
    10,
  );
}

function cleanFilePath(text: string): string {
  return text.replace(/[​-‏﻿]/g, "").trim();
}

function findRowForLine(path: string, line: number): Element | null {
  const fileBlocks = document.querySelectorAll(selectors.fileBlock);
  const seen = new Set<Element>();
  for (const block of fileBlocks) {
    if (seen.has(block)) continue;
    seen.add(block);
    const pathEl = block.querySelector(selectors.filePath);
    const rawPath =
      pathEl?.getAttribute("title") ?? pathEl?.textContent ?? "";
    const blockPath = cleanFilePath(rawPath);
    if (blockPath !== path) continue;

    const rows = block.querySelectorAll(selectors.diffRowAlt);
    for (const row of rows) {
      if (getLineNumber(row) === line) return row;
    }
  }
  return null;
}

export function resetUi(): void {
  document.querySelectorAll(".ares-gutter").forEach((el) => el.remove());
  bannerEl?.remove();
  bannerEl = null;
  closeHoverCard();
}

export function renderBanner(count: number, conflicts: Conflict[]): void {
  bannerEl?.remove();

  const firstBlock = document.querySelector(selectors.fileBlock);
  if (!firstBlock?.parentElement) return;

  bannerEl = document.createElement("div");
  bannerEl.className = "ares-banner";
  bannerEl.innerHTML = `<span class="ares-banner-text">⚠ ${count} ARES conflict${count > 1 ? "s" : ""} found</span>`;

  const list = document.createElement("ul");
  list.className = "ares-banner-list";
  list.hidden = true;

  for (const conflict of conflicts) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = `${conflict.location.path}:${conflict.location.start_line}`;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const mark = document.querySelector(
        `[data-conflict-id="${conflict.id}"]`,
      );
      mark?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    item.appendChild(link);
    list.appendChild(item);
  }

  bannerEl.appendChild(list);
  bannerEl.addEventListener("click", () => {
    list.hidden = !list.hidden;
  });

  firstBlock.parentElement.insertBefore(bannerEl, firstBlock);
}

export function renderConflicts(
  conflicts: Conflict[],
  hunkLookup: HunkLookup,
): void {
  for (const conflict of conflicts) {
    const { path, start_line, end_line } = conflict.location;
    const targetRow =
      findRowForLine(path, start_line) ?? findRowForLine(path, end_line);
    if (!targetRow) continue;
    if (targetRow.querySelector(".ares-gutter")) continue;

    // Prefer the diff-text content cell (wide, easy to see). Fall back to
    // the line-number cell or the row itself.
    const contentCell =
      targetRow.querySelector("td.diff-text-cell") ??
      targetRow.querySelector(selectors.newLineCell) ??
      targetRow.querySelector("td.blob-num") ??
      targetRow;

    // Ensure we can absolutely-position the marker inside the cell.
    if (contentCell instanceof HTMLElement) {
      const computed = window.getComputedStyle(contentCell);
      if (computed.position === "static") {
        contentCell.style.position = "relative";
      }
    }

    const gutter = document.createElement("span");
    gutter.className = "ares-gutter";
    gutter.dataset.conflictId = conflict.id;
    gutter.textContent = "";
    gutter.setAttribute("title", "ARES memory conflict — hover for details");
    gutter.setAttribute("aria-label", "ARES memory conflict");
    contentCell.appendChild(gutter);

    mountHoverCard(gutter, conflict, hunkLookup);
  }
}

function closeHoverCard(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  activeCard?.remove();
  activeCard = null;
}

function positionCard(card: HTMLElement, target: Element): void {
  const rect = target.getBoundingClientRect();
  const cardWidth = 360;
  let left = rect.right + 8;
  if (left + cardWidth > window.innerWidth) {
    left = rect.left - cardWidth - 8;
  }
  const top = Math.min(rect.top, window.innerHeight - 340);
  card.style.left = `${Math.max(8, left)}px`;
  card.style.top = `${Math.max(8, top)}px`;
}

function renderDiffLines(text: string | null | undefined, fallback = "(no diff captured)"): string {
  if (!text) return `<div class="ares-diff-empty">${escapeHtml(fallback)}</div>`;
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines
    .map((line) => {
      const cls = line.startsWith("+")
        ? "ares-diff-add"
        : line.startsWith("-")
          ? "ares-diff-del"
          : "ares-diff-ctx";
      return `<div class="ares-diff-line ${cls}">${escapeHtml(line)}</div>`;
    })
    .join("");
}

export function mountHoverCard(
  target: Element,
  conflict: Conflict,
  hunkLookup: HunkLookup,
): void {
  const show = () => {
    closeHoverCard();
    const { decision, location } = conflict;
    const author = decision.author ?? "unknown";
    const sourceUrl = decision.source_url ?? "#";
    const similarityPct = Math.round(conflict.similarity * 100);
    const confidencePct = Math.round(conflict.confidence * 100);

    // The "then" diff: stored at decision creation time. v2 stores it under
    // `context_code`; fall back to v1's `context_diff` for cached rows.
    const thenDiff = decision.context_code ?? decision.context_diff;

    // The "now" diff: the added lines on this PR that triggered the match.
    const addedLines = hunkLookup(location.path, location.start_line);
    const nowDiff = addedLines && addedLines.length
      ? addedLines.map((l) => "+ " + l).join("\n")
      : null;

    const linesLabel =
      location.start_line === location.end_line
        ? `line ${location.start_line}`
        : `lines ${location.start_line}–${location.end_line}`;

    const card = document.createElement("div");
    card.className = "ares-card";
    card.setAttribute("role", "dialog");
    card.innerHTML = `
      <div class="ares-card-header">
        <span class="ares-warn">⚠ Memory conflict</span>
        <span class="ares-meta">${escapeHtml(author)} · ${escapeHtml(formatDate(decision.created_at))}</span>
      </div>
      <p class="ares-decision">${escapeHtml(decision.statement)}</p>
      <p class="ares-reasoning"><strong>Why this triggers:</strong> ${escapeHtml(conflict.reasoning)}</p>

      <div class="ares-compare">
        <div class="ares-compare-section">
          <div class="ares-compare-label">
            <span class="ares-compare-tag ares-tag-then">Then</span>
            <span class="ares-compare-sub">${escapeHtml(author)} · ${escapeHtml(formatDate(decision.created_at))}</span>
          </div>
          <pre class="ares-diff">${renderDiffLines(thenDiff, "(no original diff captured)")}</pre>
        </div>
        <div class="ares-compare-section">
          <div class="ares-compare-label">
            <span class="ares-compare-tag ares-tag-now">Now</span>
            <span class="ares-compare-sub">${escapeHtml(location.path)} · ${escapeHtml(linesLabel)}</span>
          </div>
          <pre class="ares-diff">${renderDiffLines(nowDiff, "(could not extract hunk)")}</pre>
        </div>
      </div>

      <div class="ares-metrics">
        <span class="ares-metric"><span class="ares-metric-label">match</span> ${similarityPct}%</span>
        <span class="ares-metric"><span class="ares-metric-label">judge</span> ${confidencePct}%</span>
      </div>

      <div class="ares-actions">
        <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">View original →</a>
        <span class="ares-override-actions">
          <button type="button" class="ares-override-btn" data-override="intentional">Override: intentional</button>
          <button type="button" class="ares-override-btn" data-override="accidental">Override: accidental</button>
        </span>
      </div>
    `;

    card.querySelectorAll<HTMLButtonElement>(".ares-override-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.override as OverrideType;
        overrideHandler?.(conflict.id, type);
        closeHoverCard();
      });
    });

    card.addEventListener("mouseenter", () => {
      if (hoverTimer) clearTimeout(hoverTimer);
    });
    card.addEventListener("mouseleave", closeHoverCard);

    document.body.appendChild(card);
    positionCard(card, target);
    activeCard = card;
  };

  target.addEventListener("mouseenter", () => {
    hoverTimer = setTimeout(show, 200);
  });
  target.addEventListener("mouseleave", () => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    setTimeout(() => {
      if (!activeCard?.matches(":hover")) closeHoverCard();
    }, 100);
  });
}


export function injectAresButton(
  header: Element,
  onClick: () => void,
): void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ares-header-btn";
  btn.textContent = "Ask ARES";
  btn.addEventListener("click", onClick);
  header.appendChild(btn);
}

function renderCitationPills(container: HTMLElement, text: string): void {
  container.textContent = "";
  const parts = text.split(/(\[[^\]]+\])/g);
  for (const part of parts) {
    const match = part.match(/^\[(.+)\]$/);
    if (match) {
      const pill = document.createElement("span");
      pill.className = "ares-citation";
      pill.dataset.id = match[1];
      pill.textContent = `[${match[1].slice(0, 8)}]`;
      pill.title = match[1];
      pill.addEventListener("click", () => {
        pill.classList.toggle("ares-citation-expanded");
        pill.textContent = pill.classList.contains("ares-citation-expanded")
          ? match[1]
          : `[${match[1].slice(0, 8)}]`;
      });
      container.appendChild(pill);
    } else if (part) {
      container.appendChild(document.createTextNode(part));
    }
  }
}

function appendMessage(
  list: HTMLElement,
  role: "user" | "assistant",
  text: string,
): HTMLElement {
  const msg = document.createElement("div");
  msg.className = `ares-msg ares-msg-${role}`;
  if (role === "assistant") {
    renderCitationPills(msg, text);
  } else {
    msg.textContent = text;
  }
  list.appendChild(msg);
  list.scrollTop = list.scrollHeight;
  return msg;
}

export function openSidePanel(repoId: string): void {
  if (panelEl) {
    panelEl.classList.add("ares-panel-open");
    return;
  }

  panelEl = document.createElement("div");
  panelEl.className = "ares-panel ares-panel-open";
  panelEl.innerHTML = `
    <div class="ares-panel-header">
      <span class="ares-panel-title">Ask ARES</span>
      <button type="button" class="ares-panel-close" aria-label="Close">×</button>
    </div>
    <div class="ares-panel-messages"></div>
    <div class="ares-panel-input">
      <textarea placeholder="Ask about past decisions…" rows="2"></textarea>
      <button type="button" class="ares-panel-send">Send</button>
    </div>
  `;

  const closeBtn = panelEl.querySelector(".ares-panel-close")!;
  const messages = panelEl.querySelector(".ares-panel-messages") as HTMLElement;
  const textarea = panelEl.querySelector("textarea") as HTMLTextAreaElement;
  const sendBtn = panelEl.querySelector(".ares-panel-send") as HTMLButtonElement;

  closeBtn.addEventListener("click", closeSidePanel);

  const send = async () => {
    const input = textarea.value.trim();
    if (!input) return;
    textarea.value = "";
    sendBtn.disabled = true;
    appendMessage(messages, "user", input);

    const assistantEl = appendMessage(messages, "assistant", "");

    try {
      // Routes through background → POST /v1/ask (stateless RAG). The answer is
      // returned as a single text blob for now (no incremental streaming).
      const response = await chrome.runtime.sendMessage({
        type: "ASK",
        payload: { question: input, repo_id: repoId },
      });

      if (!response?.ok) {
        throw new Error(response?.error ?? "Ask request failed");
      }

      const answer = (response.data as { answer?: string })?.answer ?? "";
      renderCitationPills(assistantEl, answer);
      messages.scrollTop = messages.scrollHeight;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      renderCitationPills(assistantEl, `Error: ${message}`);
    } finally {
      sendBtn.disabled = false;
    }
  };

  sendBtn.addEventListener("click", () => void send());
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  document.body.appendChild(panelEl);
}

export function closeSidePanel(): void {
  panelEl?.classList.remove("ares-panel-open");
}
