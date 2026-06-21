---
name: ares-memory
description: Use the ARES MCP tools before and after writing code in any repository — bootstrap the repo's learned conventions, recall relevant past decisions before implementing, and check new code for conflicts after. Use whenever modifying code, implementing a feature, refactoring, or making an engineering choice (auth, caching, IDs, retries, error handling, dependencies, logging, APIs, style).
---

# ARES — codebase conventions

ARES has learned this team's written and unwritten rules (from the repo's docs
and its PR review history). Treat what it returns as **binding context**.

## Identify the repo
Derive `repo` as `owner/repo` (lowercase) from `git remote get-url origin`
(strip the host and trailing `.git`). Pass it to every ARES tool call.

## Workflow

1. **Once per repo per session** — call `ares.ensure_repo_memory({ repo })`.
   Returns immediately; if the repo is new it learns it in the background, if
   already learned it's an instant no-op.
2. **Before writing/modifying non-trivial code** — call
   `ares.recall_decisions({ query, repo })` describing what you're about to do.
   Follow any applicable rule; if you must deviate, say so and cite `[id]`.
3. **After writing code** — call `ares.check_conflict({ repo, intent, snippet })`
   with the code you produced and a one-line `intent`. If it returns conflicts,
   rewrite to comply or explain the intentional override and cite `[id]`.
4. **When a durable rule is established** — call `ares.record_decision({ repo,
   statement, rationale })` so future agents and humans respect it.

## Rule
Do not skip `recall_decisions` — the goal is that the mistake never gets typed,
not that it gets caught in review. If ARES is unreachable, say so and proceed
without blocking.
