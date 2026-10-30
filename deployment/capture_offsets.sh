#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

offsets_file="$repo_dir/.runtime/offsets.env"
if grep -q '^FRESH_BOUNDARY_CAPTURED=true$' "$offsets_file"; then
  echo "Preserving previously captured fresh-consumer boundary"
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

line=$(compose exec -T kafka kafka-get-offsets \
  --bootstrap-server kafka:29092 --topic payments.enriched.demo | tr -d '\r')
offset=$(printf '%s\n' "$line" | awk -F: '$1 == "payments.enriched.demo" && $2 == "0" {print $3}')
case "$offset" in
  ''|*[!0-9]*)
    echo "Could not determine payments.enriched.demo partition 0 boundary" >&2
    exit 1
    ;;
esac

umask 077
tmp="$repo_dir/.runtime/offsets.env.tmp.$$"
{
  echo "ROUTER_EXPECTED_START_OFFSETS=0:$offset"
  echo "FRAUD_ML_EXPECTED_START_OFFSETS=0:$offset"
  echo "FRESH_BOUNDARY_CAPTURED=true"
} >"$tmp"
mv "$tmp" "$repo_dir/.runtime/offsets.env"
echo "Captured fresh-consumer boundary payments.enriched.demo:0:$offset"

