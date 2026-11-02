#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/common.sh"

if [ ! -f "$repo_dir/.env" ]; then
  echo "Root deployment environment is missing; run make prepare first." >&2
  exit 1
fi

live_port=${GLARAMARA_LIVE_HOST_PORT:-13001}
case "$live_port" in
  *[!0-9]*|"")
    echo "GLARAMARA_LIVE_HOST_PORT must be a numeric localhost port." >&2
    exit 1
    ;;
esac

postgres_db=$(env_value POSTGRES_DB)
postgres_user=$(env_value POSTGRES_USER)
postgres_password=$(env_value POSTGRES_PASSWORD)
postgres_port=$(env_value POSTGRES_HOST_PORT)
session_secret=$(env_value GLARAMARA_SESSION_SECRET)
for required_value in "$postgres_db" "$postgres_user" "$postgres_password" "$postgres_port" "$session_secret"; do
  if [ -z "$required_value" ]; then
    echo "The root deployment environment is incomplete." >&2
    exit 1
  fi
done

export DATABASE_URL="postgresql://${postgres_user}:${postgres_password}@127.0.0.1:${postgres_port}/${postgres_db}"
export GLARAMARA_SESSION_SECRET="$session_secret"
export GLARAMARA_PUBLIC_ORIGIN="http://127.0.0.1:${live_port}"
export GLARAMARA_COOKIE_SECURE=false
export FRAUD_INTELLIGENCE_PROVIDER=orchestrate
export FRAUD_INTELLIGENCE_MODEL=${FRAUD_INTELLIGENCE_MODEL:-groq/openai/gpt-oss-120b}
export FRAUD_INTELLIGENCE_TIMEOUT_MS=${FRAUD_INTELLIGENCE_TIMEOUT_MS:-45000}

cd "$repo_dir/glaramara-bank"
exec npm run start -- --hostname 127.0.0.1 --port "$live_port"
