#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project=${COMPOSE_PROJECT_NAME:-fraud-platform-dev}
profiles=${COMPOSE_PROFILES:-}

case ",$profiles," in
  *,tools,*) ;;
  ,,) profiles=tools ;;
  *) profiles="$profiles,tools" ;;
esac

export COMPOSE_PROFILES="$profiles"
exec podman compose --profile tools -p "$project" -f "$repo_dir/compose.yaml" "$@"
