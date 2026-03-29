#!/usr/bin/env bash
# Persistent “kick the tires” stack: same docker-compose.yml + env overlay pattern as readiness
# (tests/docker-compose.readiness.yml), but `compose up -d` only — no test runner, no §13 trigger flow.
#
# Binds <#1487579255616573533> → session `main` unless overridden in `.env.shoggoth.local`.
# Prerequisites: Docker, `.env.shoggoth.local` (copy `.env.shoggoth.example`).
# Optional: SHOGGOTH_EXTRA_COMPOSE_FILE=docker-compose.proxy-network.yml when LM lives on an external `proxy` network.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Same fallback as tests/readiness-compose.test.mjs: supplementary `docker` group may require `sg docker`.
docker_cli() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    local quoted="docker"
    for a in "$@"; do
      quoted+=" $(printf '%q' "$a")"
    done
    sg docker -c "$quoted"
  fi
}

if ! docker info >/dev/null 2>&1 && ! sg docker -c "docker info" >/dev/null 2>&1; then
  echo "docker not available (tried docker and sg docker)" >&2
  exit 1
fi

ENV_LOCAL="$ROOT/.env.shoggoth.local"
if [[ -f "$ENV_LOCAL" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_LOCAL"
  set +a
fi

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
  echo "DISCORD_BOT_TOKEN is unset: copy $ROOT/.env.shoggoth.example to .env.shoggoth.local and set the Shoggoth bot token" >&2
  exit 1
fi

if [[ -z "${SHOGGOTH_DISCORD_ROUTES:-}" ]]; then
  export SHOGGOTH_DISCORD_ROUTES='[{"guildId":"695327822306345040","channelId":"1487579255616573533","sessionId":"main"}]'
fi
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-shoggoth-kick}"

compose_files=( -f docker-compose.yml -f docker-compose.kick-tires.yml )
if [[ -n "${SHOGGOTH_EXTRA_COMPOSE_FILE:-}" ]]; then
  extra="$SHOGGOTH_EXTRA_COMPOSE_FILE"
  [[ "$extra" = /* ]] || extra="$ROOT/$extra"
  compose_files+=( -f "$extra" )
fi

docker_cli compose "${compose_files[@]}" up -d --build

docker_cli compose "${compose_files[@]}" exec -T -u shoggoth -w /app shoggoth \
  node --import tsx/esm scripts/bootstrap-main-session.mjs

echo ""
echo "Shoggoth is up (project ${COMPOSE_PROJECT_NAME}). Session: main → <#1487579255616573533>."
echo "Default SHOGGOTH_OPERATOR_TOKEN=${SHOGGOTH_OPERATOR_TOKEN:-shoggoth-kick-operator-token} (override before up if you use control CLI)."
echo "Logs: docker compose ${compose_files[*]} logs -f shoggoth"
echo "       (if plain docker fails: sg docker -c 'docker compose ${compose_files[*]} logs -f shoggoth')"
echo "Stop: docker compose ${compose_files[*]} down"
