SHELL := /bin/sh

export COMPOSE_PROJECT_NAME ?= fraud-platform-dev
COMPOSE = podman compose -p $(COMPOSE_PROJECT_NAME) -f compose.yaml

.PHONY: build up down restart status smoke-test logs reset prepare config

prepare:
	@./deployment/ensure_env.sh

config: prepare
	@$(COMPOSE) config >/dev/null

build: prepare
	$(COMPOSE) build jobmanager fraud-router fraud-assessment-correlator fraud-decision-engine

up: prepare
	@./deployment/up.sh

down: prepare
	@./deployment/down.sh

restart: down up

status: prepare
	@./deployment/status.sh

smoke-test: prepare
	@$(COMPOSE) run --rm --no-deps smoke-runner python /deployment/smoke_test.py

logs: prepare
	$(COMPOSE) logs --tail="$${LOG_TAIL:-200}"

reset: prepare
	@./deployment/reset.sh

