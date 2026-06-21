#!/usr/bin/env bash
# ARES one-command setup.
#   ./setup.sh                 full setup (interactive Cursor install prompt)
#   ./setup.sh --install-cursor  also install ARES into Cursor globally, no prompt
#   ./setup.sh --no-cursor       skip the Cursor install entirely
set -euo pipefail

cd "$(dirname "$0")"
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; NC=$'\033[0m'
say()  { printf "%s\n" "$*"; }
ok()   { printf "${GRN}✓${NC} %s\n" "$*"; }
warn() { printf "${YEL}!${NC} %s\n" "$*"; }
die()  { printf "${RED}✗ %s${NC}\n" "$*" >&2; exit 1; }
hr()   { printf "${DIM}%s${NC}\n" "──────────────────────────────────────────────────────────────"; }

CURSOR_MODE="prompt"
for arg in "$@"; do
  case "$arg" in
    --install-cursor) CURSOR_MODE="yes" ;;
    --no-cursor)      CURSOR_MODE="no" ;;
  esac
done

# ---------- prerequisites ----------
command -v docker >/dev/null 2>&1 || die "Docker is required. Install Docker Desktop and retry."
if docker compose version >/dev/null 2>&1; then DC="docker compose";
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose";
else die "Docker Compose is required."; fi
docker info >/dev/null 2>&1 || die "Docker daemon isn't running. Start Docker Desktop and retry."
command -v curl >/dev/null 2>&1 || die "curl is required."

say "${BOLD}ARES setup${NC}"
hr

# ---------- .env ----------
if [ ! -f .env ]; then cp .env.example .env; ok "created .env from .env.example"; fi

get_env() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
set_env() { # set_env KEY VALUE  (portable, no sed -i)
  local k="$1" v="$2" tmp; tmp="$(mktemp)"
  if grep -qE "^$k=" .env; then
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' .env > "$tmp"
  else printf "%s=%s\n" "$k" "$v" >> .env; cp .env "$tmp"; fi
  mv "$tmp" .env
}

if [ -z "$(get_env OPENAI_API_KEY)" ]; then
  hr; say "ARES uses OpenAI for embeddings + the conflict judge."
  printf "Enter your OPENAI_API_KEY (sk-...): "
  read -rs OPENAI_INPUT; echo
  [ -n "$OPENAI_INPUT" ] || die "OPENAI_API_KEY is required."
  set_env OPENAI_API_KEY "$OPENAI_INPUT"; ok "saved OPENAI_API_KEY to .env"
else ok "OPENAI_API_KEY already set"; fi

# Optional GitHub token (improves PR-review mining; docs work without it)
if [ -z "$(get_env GITHUB_TOKEN)" ]; then
  if command -v gh >/dev/null 2>&1 && gh auth token >/dev/null 2>&1; then
    set_env GITHUB_TOKEN "$(gh auth token)"; ok "used your gh CLI token for richer PR-review mining"
  else
    warn "No GITHUB_TOKEN set — repo onboarding will use docs + limited public reviews. (Optional: add a token to .env later.)"
  fi
fi

# ---------- bring up the stack ----------
hr; say "Building & starting Postgres + ARES (this may take a minute the first time)…"
set -a; . ./.env; set +a
$DC up -d --build

printf "Waiting for ARES to be healthy"
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/v1/health || true)"
  [ "$code" = "200" ] && break
  printf "."; sleep 2
done
echo
[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/v1/health)" = "200" ] \
  || die "Server didn't become healthy. Check: $DC logs server"
ok "ARES is running on http://localhost:8787"

# ---------- seed workspace + API key (idempotent) ----------
hr
if [ -f .ares-key ] && grep -q 'ares_sk_' .ares-key 2>/dev/null; then
  ARES_KEY="$(cat .ares-key)"; ok "reusing existing API key (.ares-key)"
else
  say "Creating a workspace + API key…"
  SEED_OUT="$($DC exec -T server npm run seed 2>&1 || true)"
  ARES_KEY="$(printf "%s" "$SEED_OUT" | grep -oE 'ares_sk_[A-Za-z0-9]+' | head -1 || true)"
  [ -n "$ARES_KEY" ] || { printf "%s\n" "$SEED_OUT"; die "Could not create an API key (see seed output above)."; }
  printf "%s" "$ARES_KEY" > .ares-key; chmod 600 .ares-key
  ok "API key created and saved to .ares-key"
fi

# ---------- generate Cursor MCP config ----------
mkdir -p generated
cat > generated/cursor-mcp.json <<JSON
{
  "mcpServers": {
    "ares": {
      "url": "http://localhost:8787/mcp",
      "headers": {
        "Authorization": "Bearer ${ARES_KEY}"
      }
    }
  }
}
JSON
ok "wrote generated/cursor-mcp.json (with your key)"

# ---------- optional: install into Cursor globally ----------
install_cursor() {
  local home_cursor="$HOME/.cursor"
  mkdir -p "$home_cursor/skills" "$home_cursor/rules"
  # merge mcp.json (preserve any existing servers) using python3 if available
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$home_cursor/mcp.json" "$ARES_KEY" <<'PY'
import json, os, sys
path, key = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(path):
    try: data = json.load(open(path))
    except Exception: data = {}
data.setdefault("mcpServers", {})
data["mcpServers"]["ares"] = {
    "url": "http://localhost:8787/mcp",
    "headers": {"Authorization": f"Bearer {key}"},
}
json.dump(data, open(path, "w"), indent=2)
print("merged", path)
PY
  else
    cp generated/cursor-mcp.json "$home_cursor/mcp.json"
  fi
  cp -R cursor/skills/* "$home_cursor/skills/" 2>/dev/null || true
  cp cursor/rules/ares.mdc "$home_cursor/rules/ares.mdc" 2>/dev/null || true
  ok "installed ARES into Cursor globally (~/.cursor): mcp.json + 3 skills + rule"
  warn "Reload Cursor (or restart) and enable the 'ares' server under Settings → Tools & MCP."
}

DO_INSTALL="no"
case "$CURSOR_MODE" in
  yes) DO_INSTALL="yes" ;;
  no)  DO_INSTALL="no" ;;
  prompt)
    hr; printf "Install ARES into Cursor globally now (every window)? [y/N] "
    read -r ans || true
    case "${ans:-}" in y|Y|yes|YES) DO_INSTALL="yes" ;; esac ;;
esac
[ "$DO_INSTALL" = "yes" ] && install_cursor

# ---------- done ----------
hr
say "${BOLD}${GRN}ARES is ready.${NC}"
say ""
say "API key (also in .ares-key): ${BOLD}${ARES_KEY}${NC}"
say ""
if [ "$DO_INSTALL" != "yes" ]; then
  say "To use it in Cursor, add this to ${BOLD}~/.cursor/mcp.json${NC} (global) or a project's ${BOLD}.cursor/mcp.json${NC}:"
  say "${DIM}$(cat generated/cursor-mcp.json)${NC}"
  say ""
  say "Then copy the skills: ${DIM}cp -R cursor/skills/* ~/.cursor/skills/ && cp cursor/rules/ares.mdc ~/.cursor/rules/${NC}"
  say ""
fi
say "Next: open any repo in Cursor and ask it to onboard the repo, e.g.:"
say "  ${DIM}\"Use the ares-onboard-repo skill to onboard <owner/repo>\"${NC}"
say ""
say "Manage:  ${DIM}$DC logs -f server${NC} · stop: ${DIM}$DC down${NC} · restart: ${DIM}$DC up -d${NC}"
