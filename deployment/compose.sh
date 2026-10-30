#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project=${COMPOSE_PROJECT_NAME:-fraud-platform-dev}
profiles=${COMPOSE_PROFILES:-}

# The private deployment file is authoritative. Compose otherwise gives exported
# shell variables precedence over .env, which can split a persisted database from
# the credentials used by migrations and workers.
if [ -f "$repo_dir/.env" ]; then
  set -a
  . "$repo_dir/.env"
  set +a
fi

case ",$profiles," in
  *,tools,*) ;;
  ,,) profiles=tools ;;
  *) profiles="$profiles,tools" ;;
esac

export COMPOSE_PROFILES="$profiles"
exec podman compose --profile tools -p "$project" -f "$repo_dir/compose.yaml" "$@"
