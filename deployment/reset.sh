#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

echo "This deletes Kafka, PostgreSQL, and Flink state only for Compose project: $project"
printf 'Type the project name to confirm: '
read -r confirmation
if [ "$confirmation" != "$project" ]; then
  echo "Reset cancelled"
  exit 1
fi

compose down --volumes --remove-orphans
rm -f \
  "$repo_dir/.runtime/flink-savepoints.env" \
  "$repo_dir/.runtime/flink-savepoints.applied.env" \
  "$repo_dir/.runtime/flink-start-status" \
  "$repo_dir/.runtime/offsets.env"
"$repo_dir/deployment/ensure_env.sh"
echo "Deleted only $project runtime state; .env and all golden resources were preserved"

