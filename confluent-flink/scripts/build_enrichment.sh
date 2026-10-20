#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
podman run --rm \
  -e MAVEN_OPTS=-Xmx512m \
  -v fraud-enrichment-m2:/root/.m2 \
  -v "$project_dir:/workspace:Z" \
  -w /workspace \
  docker.io/library/maven:3.9.9-eclipse-temurin-11 \
  mvn -B clean verify
