#!/usr/bin/env bash
#
# ARES CI guardrail — fail the build when generated/changed code conflicts with
# a recorded team decision at high confidence.
#
# Drop this into any CI pipeline. It posts the PR diff to ARES `POST /v1/check`
# and exits non-zero if any returned conflict has confidence >= 0.8.
#
# Required environment variables:
#   ARES_API_URL   base URL of your ARES server, e.g. https://ares.yourco.com
#   ARES_API_KEY   workspace API key, e.g. ares_sk_...
#   REPO           "owner/repo" (lowercase) that scopes the decisions
#
# Optional:
#   BASE_REF       git ref to diff against (default: origin/main)
#   FAIL_THRESHOLD confidence at/above which to fail the build (default: 0.8)

set -euo pipefail

: "${ARES_API_URL:?set ARES_API_URL (e.g. https://ares.yourco.com)}"
: "${ARES_API_KEY:?set ARES_API_KEY (e.g. ares_sk_...)}"
: "${REPO:?set REPO (e.g. owner/repo)}"

BASE_REF="${BASE_REF:-origin/main}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-0.8}"

for bin in curl jq git; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ares-ci: '$bin' is required but not installed" >&2; exit 2; }
done

# Collect the diff of the current change set.
DIFF="$(git diff "${BASE_REF}"...HEAD 2>/dev/null || git diff "${BASE_REF}" 2>/dev/null || true)"

if [ -z "${DIFF}" ]; then
  echo "ares-ci: no diff against ${BASE_REF}; nothing to check."
  exit 0
fi

# Build the request body. The diff is sent as a single snippet; ARES embeds it,
# recalls the most similar active decisions, and judges for conflicts.
REQUEST_BODY="$(jq -n \
  --arg repo "${REPO}" \
  --arg snippet "${DIFF}" \
  --arg intent "CI check of the pull request diff" \
  '{repo: $repo, intent: $intent, snippet: $snippet}')"

RESPONSE="$(curl -sS -X POST "${ARES_API_URL%/}/v1/check" \
  -H "Authorization: Bearer ${ARES_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${REQUEST_BODY}")"

# Surface every conflict for the CI log.
echo "${RESPONSE}" | jq -r '
  if (.conflicts | length) == 0 then
    "ares-ci: no conflicts found."
  else
    (.conflicts[] |
      "ares-ci: CONFLICT (sim=\(.similarity) conf=\(.confidence)) "
      + (.decision.statement // "")
      + " — " + (.reasoning // ""))
  end'

# Fail only on high-confidence conflicts.
BLOCKING="$(echo "${RESPONSE}" | jq --argjson t "${FAIL_THRESHOLD}" \
  '[.conflicts[]? | select(.confidence >= $t)] | length')"

if [ "${BLOCKING}" -gt 0 ]; then
  echo "ares-ci: ${BLOCKING} conflict(s) at confidence >= ${FAIL_THRESHOLD}. Failing build." >&2
  exit 1
fi

echo "ares-ci: passed (no conflicts at confidence >= ${FAIL_THRESHOLD})."
exit 0
