#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

jobmanager_id=$(service_container_id jobmanager)
if [ -n "$jobmanager_id" ]; then
  state=$(podman inspect --format '{{.State.Status}}' "$jobmanager_id")
  if [ "$state" = running ]; then
    echo "Creating Flink savepoints before stopping $project"
    "$repo_dir/deployment/save_flink_state.sh"
  fi
fi

compose down --remove-orphans
echo "Stopped only Compose project $project; named data volumes were retained"

