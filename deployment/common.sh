#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project=${COMPOSE_PROJECT_NAME:-fraud-platform-dev}

compose() {
  "$repo_dir/deployment/compose.sh" "$@"
}

env_value() {
  key=$1
  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
  ' "$repo_dir/.env"
}

service_container_id() {
  service=$1
  podman ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" \
    --format '{{.ID}}' | head -n 1
}

wait_for_health() {
  service=$1
  attempts=${2:-36}
  attempt=0
  while [ "$attempt" -lt "$attempts" ]; do
    container_id=$(service_container_id "$service")
    if [ -n "$container_id" ]; then
      state=$(podman inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")
      case "$state" in
        "running healthy") return 0 ;;
        exited*|dead*)
          echo "$service stopped before becoming healthy: $state" >&2
          return 1
          ;;
      esac
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  echo "$service did not become healthy" >&2
  return 1
}

wait_for_log() {
  service=$1
  pattern=$2
  attempts=${3:-30}
  attempt=0
  while [ "$attempt" -lt "$attempts" ]; do
    if compose logs --no-color "$service" 2>/dev/null | grep -q "$pattern"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  echo "$service did not report readiness marker $pattern" >&2
  return 1
}

