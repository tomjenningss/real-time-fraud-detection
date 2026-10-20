#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
topic=${1:-payments.enriched.demo}
podman compose exec -T kafka kafka-get-offsets \
  --bootstrap-server kafka:29092 --topic "$topic" --time -1 |
  awk -F: '{if (output != "") output=output ","; output=output $2 ":" $3} END {print output}'
