#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

cd "$repo_dir"
echo "Starting isolated base services for Compose project $project"
compose up -d kafka postgres
wait_for_health kafka 48
wait_for_health postgres 36

echo "Applying idempotent PostgreSQL migrations"
compose run --rm migrations

"$repo_dir/deployment/create_topics.sh"

echo "Preparing UID 9999 checkpoint storage"
compose run --rm --no-deps checkpoint-init

echo "Starting the Flink session cluster"
compose up -d jobmanager taskmanager
wait_for_health jobmanager 36
"$repo_dir/deployment/ensure_flink_jobs.sh"

"$repo_dir/deployment/capture_offsets.sh"

echo "Starting Python and Go application services"
compose up -d \
  fraud-router outbox-publisher lightgbm-scorer \
  fraud-assessment-correlator fraud-decision-engine

wait_for_health fraud-router 36
wait_for_health outbox-publisher 36
wait_for_health lightgbm-scorer 36
wait_for_health fraud-assessment-correlator 36
wait_for_health fraud-decision-engine 36
wait_for_log fraud-router '"event":"router_ready"' 30
wait_for_log outbox-publisher '"event":"outbox_ready"' 30
wait_for_log lightgbm-scorer '"event": "shadow_scorer_ready"' 30
wait_for_log fraud-assessment-correlator 'correlator ready' 30
wait_for_log fraud-decision-engine 'shadow decision engine ready' 30

"$repo_dir/deployment/status.sh"

