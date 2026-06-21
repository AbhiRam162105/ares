// Selectors for the modern GitHub PR /changes diff view (2026 React layout).
// We try the new layout first and fall back to the legacy /files DOM where possible.

export const selectors = {
  // ---- File-block selectors ----------------------------------------------
  // New layout: each file diff is a div under [data-testid="progressive-diffs-list"]
  // with class containing "diffEntry" and an inner [role="region"] with data-targeted.
  fileBlock:
    'div[data-testid="progressive-diffs-list"] > div, [role="region"][data-targeted="true"], div.js-file',
  // The file path lives in <h3 id="heading-..."> <a> <code>‎src/path‎</code>
  // The zero-width characters around the path need to be stripped by the parser.
  filePath:
    '[class*="DiffFileHeader-module__file-name"] code, div.file-info a.Link--primary[title]',

  // ---- Row selectors -----------------------------------------------------
  // New layout: every diff line is a <tr class="diff-line-row">.
  // Legacy: rows live in .diff-table tr.
  diffRow: "tr.diff-line-row, .diff-table tr",
  diffRowAlt: "tr.diff-line-row, .diff-table tr",

  // ---- Line-number cell --------------------------------------------------
  // New layout: <td class="new-diff-line-number" data-diff-side="right" data-line-number="6">6</td>
  // (the "right" side is the additions/new file side)
  // Legacy: <td class="blob-num-addition" data-line-number="...">
  newLineCell:
    'td.new-diff-line-number[data-diff-side="right"][data-line-number]:not(.empty-diff-line), td.blob-num-addition, td.blob-num-context',
  oldLineCell:
    'td.new-diff-line-number[data-diff-side="left"][data-line-number]:not(.empty-diff-line), td.blob-num-deletion',
  newLineNumberAttr: "data-line-number",

  // ---- Addition detection -----------------------------------------------
  // New layout: row contains <code class="diff-text ... addition"> (or syntax-highlighted-line addition).
  // Legacy: row contains td.blob-code-addition or the row itself has blob-code-addition class.
  isAddition: (tr: Element) =>
    tr.querySelector('code.diff-text.addition, code.addition, code.syntax-highlighted-line.addition') !== null ||
    tr.classList.contains("blob-code-addition") ||
    tr.querySelector("td.blob-code-addition") !== null,

  isDeletion: (tr: Element) =>
    tr.querySelector('code.diff-text.deletion, code.deletion') !== null ||
    tr.classList.contains("blob-code-deletion") ||
    tr.querySelector("td.blob-code-deletion") !== null,

  // Skip hunk-header rows (e.g. @@ -0,0 +1,17 @@) — they have a colspan'd cell.
  isHunkHeader: (tr: Element) =>
    tr.querySelector('td[colspan] code.hunk, td.blob-num-hunk') !== null,

  // ---- Code content -----------------------------------------------------
  // New layout: the actual code text lives inside <div class="diff-text-inner"> within <code class="diff-text">.
  // Legacy: td.blob-code-inner.
  codeContent: "code.diff-text .diff-text-inner, td.blob-code-inner",

  // ---- PR header (where we mount the ARES button) ------------------------
  // New layout exposes a sticky toolbar near the top; we try a few anchors.
  prHeader:
    '[class*="PullRequestFilesToolbar-module__toolbar"], [class*="PageHeader-Actions"], .gh-header-meta',
};
