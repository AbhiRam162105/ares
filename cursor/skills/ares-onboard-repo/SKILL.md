---
name: ares-onboard-repo
description: Bootstrap and summarize a repository's conventions with ARES, learned from its docs and PR review comments. Use when setting up ARES for a new repo, or when the user asks to ingest, mine, onboard, learn, or summarize a repo's conventions.
disable-model-invocation: true
---

# ARES onboard repo

Learn a repo's conventions and produce a summary.

## Steps

1. Resolve `repo` (`owner/repo`, lowercase) from `git remote get-url origin`, or
   use the repo the user names.
2. Call `ares.ensure_repo_memory({ repo })` (add `deep: true` for a thorough mine
   of more PR review comments — slower, more coverage).
3. It returns immediately and learns in the background (~30–60s quick; longer for
   deep). Re-call until it reports ready.
4. Call `ares.get_repo_summary({ repo })` to retrieve the themed markdown digest
   of the repo's conventions and show it to the user.

## Notes
- Learns from docs (README/CONTRIBUTING/coding-style, incl. `.rst`) and PR review
  comments (code-anchored via the reviewed diff hunk).
- Repos that develop off-GitHub (e.g. mailing-list projects) yield mostly
  doc-based conventions; that's expected.
