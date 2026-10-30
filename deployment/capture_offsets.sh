#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

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
} >"$tmp"
mv "$tmp" "$repo_dir/.runtime/offsets.env"
echo "Captured fresh-consumer boundary payments.enriched.demo:0:$offset"

