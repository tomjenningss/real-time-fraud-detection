#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$repo_dir/.env"
runtime_dir="$repo_dir/.runtime"
project=${COMPOSE_PROJECT_NAME:-fraud-platform-dev}
postgres_volume="${project}_postgres-data"

mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"

if [ ! -f "$env_file" ]; then
  set +e
  podman volume exists "$postgres_volume" >/dev/null 2>&1
  volume_result=$?
  set -e
  case "$volume_result" in
    0)
      echo "Refusing to generate .env because retained PostgreSQL volume $postgres_volume exists." >&2
      echo "Restore the .env that initialized this volume or reconcile its database credential explicitly." >&2
      exit 1
      ;;
    1) ;;
    *)
      echo "Could not inspect PostgreSQL volume state; start the Podman machine and retry." >&2
      exit 1
      ;;
  esac
  umask 077
  password=$(openssl rand -hex 24)
  session_secret=$(openssl rand -hex 32)
  tmp="$env_file.tmp.$$"
  {
    echo "POSTGRES_DB=fraud_demo"
    echo "POSTGRES_USER=fraud_app"
    echo "POSTGRES_PASSWORD=$password"
    echo "CLUSTER_ID=MkU3OEVBNTcwNTJENDM2Qk"
    echo "KAFKA_HOST_PORT=19092"
    echo "POSTGRES_HOST_PORT=55433"
    echo "FLINK_HOST_PORT=18081"
    echo "CORRELATOR_HOST_PORT=18082"
    echo "SHADOW_ENGINE_HOST_PORT=18083"
    echo "GLARAMARA_HOST_PORT=13000"
    echo "GLARAMARA_PUBLIC_ORIGIN=http://127.0.0.1:13000"
    echo "GLARAMARA_COOKIE_SECURE=false"
    echo "GLARAMARA_SESSION_SECRET=$session_secret"
    echo 'KAFKA_HEAP_OPTS="-Xms256m -Xmx512m"'
    echo "JOBMANAGER_MEMORY=768m"
    echo "TASKMANAGER_MEMORY=1280m"
  } >"$tmp"
  mv "$tmp" "$env_file"
  echo "Created private deployment configuration at .env"
fi

# Phase B settings are additive and do not affect retained PostgreSQL credentials.
# Upgrade an existing private deployment file in place without exposing its secret.
if ! grep -q '^GLARAMARA_HOST_PORT=' "$env_file"; then
  echo "GLARAMARA_HOST_PORT=13000" >>"$env_file"
fi
if ! grep -q '^GLARAMARA_PUBLIC_ORIGIN=' "$env_file"; then
  echo "GLARAMARA_PUBLIC_ORIGIN=http://127.0.0.1:13000" >>"$env_file"
fi
if ! grep -q '^GLARAMARA_SESSION_SECRET=' "$env_file"; then
  umask 077
  session_secret=$(openssl rand -hex 32)
  echo "GLARAMARA_SESSION_SECRET=$session_secret" >>"$env_file"
  echo "Added a private Glaramara session secret to .env"
fi
if ! grep -q '^GLARAMARA_COOKIE_SECURE=' "$env_file"; then
  echo "GLARAMARA_COOKIE_SECURE=false" >>"$env_file"
fi

for key in POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD CLUSTER_ID KAFKA_HOST_PORT \
  POSTGRES_HOST_PORT FLINK_HOST_PORT CORRELATOR_HOST_PORT SHADOW_ENGINE_HOST_PORT \
  GLARAMARA_HOST_PORT GLARAMARA_PUBLIC_ORIGIN GLARAMARA_SESSION_SECRET GLARAMARA_COOKIE_SECURE \
  KAFKA_HEAP_OPTS JOBMANAGER_MEMORY TASKMANAGER_MEMORY
do
  if ! grep -q "^${key}=" "$env_file"; then
    echo ".env is missing required setting $key" >&2
    exit 1
  fi
done

password_value=$(awk -F= '
  $1 == "POSTGRES_PASSWORD" {
    value = substr($0, index($0, "=") + 1)
    gsub(/^"|"$/, "", value)
    print value
    exit
  }
' "$env_file")
case "$password_value" in
  ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-]*)
    echo ".env POSTGRES_PASSWORD must use URL-unreserved characters only." >&2
    echo "This prevents an ambiguous or incorrectly encoded DATABASE_URL; the credential was not changed." >&2
    exit 1
    ;;
esac

if [ ! -f "$runtime_dir/offsets.env" ]; then
  umask 077
  {
    echo "ROUTER_EXPECTED_START_OFFSETS=0:0"
    echo "FRAUD_ML_EXPECTED_START_OFFSETS=0:0"
    echo "FRESH_BOUNDARY_CAPTURED=false"
  } >"$runtime_dir/offsets.env"
fi

