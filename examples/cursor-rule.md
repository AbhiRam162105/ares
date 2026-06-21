# ARES decision-memory rule

Drop this into your agent's rules so it consults the team's decision memory at
write time. For Cursor, save as `.cursor/rules/ares.md` (or paste into
**Settings → Rules**). For Claude Code / Claude Desktop, add it to your project
`CLAUDE.md` or a project rule.

---

You have access to the ARES MCP tools, which hold this team's recorded
engineering decisions. Treat recorded decisions as **binding context**.

**BEFORE writing or modifying any non-trivial code:**

1. Call `ares.recall_decisions` with a short description of what you are about
   to implement (e.g. "caching auth responses", "generating user IDs", "retry
   policy for the payments client"). Pass the `repo` ("owner/repo", lowercase)
   when you know it.
2. Read every returned decision. If a decision applies, follow it. If you must
   deviate, say so explicitly and cite the decision `[id]` and your reason.

**AFTER writing code (and before finishing your turn):**

3. Call `ares.check_conflict` with the snippet or diff you just produced (pass
   `repo` and a one-line `intent`). If it returns conflicts, rewrite the code to
   comply, or explain why the override is intentional and cite the `[id]`.

**When a new, durable rule is established** (a convention, a "we got burned by
X" lesson, a deliberate trade-off), call `ares.record_decision` with a clear
imperative `statement` and a `rationale` so future agents and humans respect it.

Do not skip the `recall_decisions` step — the goal is that the mistake never
gets typed, not that it gets caught in review.
