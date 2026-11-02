#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$repo_dir/.env"

if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "configure-orchestrate requires an interactive terminal." >&2
  exit 1
fi
if [ ! -f "$env_file" ]; then
  echo "Root deployment environment is missing; run make prepare first." >&2
  exit 1
fi

escape_single_quoted() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

printf '%s' "watsonx Orchestrate service-instance URL: "
IFS= read -r orchestrate_url
printf '%s' "watsonx Orchestrate API key (input hidden): "
stty -echo
trap 'stty echo 2>/dev/null || true' EXIT HUP INT TERM
IFS= read -r orchestrate_api_key
stty echo
trap - EXIT HUP INT TERM
printf '\n'

case "$orchestrate_url" in
  https://*.watson-orchestrate.cloud.ibm.com/instances/*) ;;
  *)
    echo "The service-instance URL must be an HTTPS IBM watsonx Orchestrate instance URL." >&2
    exit 1
    ;;
esac
case "$orchestrate_api_key" in
  '')
    echo "The API key must not be empty; .env was not changed." >&2
    exit 1
    ;;
esac

url_value=$(escape_single_quoted "$orchestrate_url")
key_value=$(escape_single_quoted "$orchestrate_api_key")
tmp_file=$(mktemp "$env_file.tmp.XXXXXX")
trap 'rm -f "$tmp_file"' EXIT HUP INT TERM
umask 077
awk '
  /^(FRAUD_INTELLIGENCE_PROVIDER|FRAUD_INTELLIGENCE_MODEL|WATSONX_ORCHESTRATE_API_KEY|WATSONX_ORCHESTRATE_URL)=/ {
    next
  }
  { print }
' "$env_file" >"$tmp_file"
{
  printf '%s\n' "FRAUD_INTELLIGENCE_PROVIDER=orchestrate"
  printf '%s\n' "FRAUD_INTELLIGENCE_MODEL=groq/openai/gpt-oss-120b"
  printf "WATSONX_ORCHESTRATE_API_KEY='%s'\n" "$key_value"
  printf "WATSONX_ORCHESTRATE_URL='%s'\n" "$url_value"
} >>"$tmp_file"
chmod 600 "$tmp_file"
mv "$tmp_file" "$env_file"
trap - EXIT HUP INT TERM

echo "Configured the local runtime for server-side watsonx Orchestrate. Run make up to apply it."
