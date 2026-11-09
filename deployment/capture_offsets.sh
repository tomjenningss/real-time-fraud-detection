#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

offsets_file="$repo_dir/.runtime/offsets.env"
replay_offset_key='SLOW_BUILDING_REPLAY_ROUTER_EXPECTED_START_OFFSETS'

topic_offset() {
  topic=$1
  line=$(compose exec -T kafka kafka-get-offsets \
    --bootstrap-server kafka:29092 --topic "$topic" | tr -d '\r')
  offset=$(printf '%s\n' "$line" | awk -F: -v topic="$topic" '$1 == topic && $2 == "0" {print $3}')
  case "$offset" in
    ''|*[!0-9]*)
      echo "Could not determine $topic partition 0 boundary" >&2
      exit 1
      ;;
  esac
  printf '%s\n' "$offset"
}

if grep -q '^FRESH_BOUNDARY_CAPTURED=true$' "$offsets_file" \
  && grep -q "^$replay_offset_key=" "$offsets_file"
then
  echo "Preserving previously captured fresh-consumer boundary"
  exit 0
fi

# Existing installations already have the live-router boundary. Capture only
# the new isolated replay boundary; never advance the live consumer boundary.
if grep -q '^FRESH_BOUNDARY_CAPTURED=true$' "$offsets_file"; then
  replay_offset=$(topic_offset payments.enriched.slow-building-replay)
  umask 077
  tmp="$repo_dir/.runtime/offsets.env.tmp.$$"
  {
    cat "$offsets_file"
    echo "$replay_offset_key=0:$replay_offset"
  } >"$tmp"
  mv "$tmp" "$offsets_file"
  echo "Captured fresh-consumer boundary payments.enriched.slow-building-replay:0:$replay_offset"
  exit 0
fi

# Runtime files created before the capture marker was introduced contain only the
# two offsets. A non-zero value is an already-captured boundary and must not be
# advanced merely because make up is run again.
if ! grep -q '^FRESH_BOUNDARY_CAPTURED=' "$offsets_file" \
  && grep -Eq '^(ROUTER_EXPECTED_START_OFFSETS|FRAUD_ML_EXPECTED_START_OFFSETS)=0:[1-9][0-9]*$' \
    "$offsets_file"
then
  echo "Preserving legacy fresh-consumer boundary"
  exit 0
fi

offset=$(topic_offset payments.enriched.demo)
replay_offset=$(topic_offset payments.enriched.slow-building-replay)

umask 077
tmp="$repo_dir/.runtime/offsets.env.tmp.$$"
{
  echo "ROUTER_EXPECTED_START_OFFSETS=0:$offset"
  echo "FRAUD_ML_EXPECTED_START_OFFSETS=0:$offset"
  echo "$replay_offset_key=0:$replay_offset"
  echo "FRESH_BOUNDARY_CAPTURED=true"
} >"$tmp"
mv "$tmp" "$repo_dir/.runtime/offsets.env"
echo "Captured fresh-consumer boundary payments.enriched.demo:0:$offset"

