#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

set +e
compose run --rm --no-deps migrations python -c '
import os
import sys

import psycopg

try:
    psycopg.connect(os.environ["DATABASE_URL"], connect_timeout=5).close()
except psycopg.OperationalError as error:
    sys.exit(10 if error.sqlstate == "28P01" else 11)
' >/dev/null 2>&1
result=$?
set -e

case "$result" in
  0)
    echo "PostgreSQL deployment credentials verified"
    ;;
  10)
    echo "PostgreSQL authentication failed for Compose project $project." >&2
    echo "The retained volume ${project}_postgres-data may have been initialized by a different .env." >&2
    echo "No data or credentials were changed. Restore the original .env or reconcile the role password explicitly." >&2
    exit 1
    ;;
  *)
    echo "PostgreSQL credential preflight could not connect to this project's postgres service." >&2
    echo "No data or credentials were changed; inspect the postgres service logs before retrying." >&2
    exit 1
    ;;
esac
