from __future__ import annotations

import os

import psycopg
from confluent_kafka.admin import AdminClient


def main() -> None:
    brokers = os.environ["KAFKA_BOOTSTRAP_SERVERS"]
    AdminClient({"bootstrap.servers": brokers}).list_topics(timeout=3)
    if os.getenv("HEALTHCHECK_DATABASE", "true").lower() == "true":
        with psycopg.connect(os.environ["DATABASE_URL"], connect_timeout=3) as connection:
            connection.execute("SELECT 1").fetchone()


if __name__ == "__main__":
    main()
