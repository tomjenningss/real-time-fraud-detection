FROM docker.io/library/python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN python -m pip install .

COPY alembic.ini ./
COPY migrations ./migrations
COPY artifacts/baseline ./artifacts/baseline

RUN groupadd --system --gid 10001 fraud \
    && useradd --system --uid 10001 --gid fraud --home-dir /app fraud \
    && chown -R fraud:fraud /app

USER fraud

