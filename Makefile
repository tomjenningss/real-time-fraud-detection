SHELL := /bin/sh

export COMPOSE_PROJECT_NAME ?= fraud-platform-dev
COMPOSE = ./deployment/compose.sh

.PHONY: build up down restart status smoke-test glaramara-smoke-test fraud-lab-next-wave fraud-lab-live-analysis logs reset prepare configure-orchestrate config test-deployment

prepare:
	@./deployment/ensure_env.sh

configure-orchestrate: prepare
	@./deployment/configure_orchestrate.sh

config: prepare
	@$(COMPOSE) config >/dev/null

build: prepare
	$(COMPOSE) pull control-center
	$(COMPOSE) build jobmanager fraud-router fraud-assessment-correlator fraud-decision-engine glaramara-bank

up: prepare
	@./deployment/up.sh

down: prepare
	@./deployment/down.sh

restart: down up

status: prepare
	@./deployment/status.sh

smoke-test: prepare
	@$(COMPOSE) run --rm --no-deps smoke-runner python /deployment/smoke_test.py

glaramara-smoke-test: prepare
	@base_url=$$(awk -F= '$$1 == "GLARAMARA_PUBLIC_ORIGIN" { value = substr($$0, index($$0, "=") + 1); gsub(/^"|"$$/, "", value); print value; exit }' .env); \
	python3 deployment/glaramara_smoke_test.py --base-url "$$base_url"

fraud-lab-next-wave: prepare
	@$(COMPOSE) run --rm --no-deps platform-cli fraud-lab-seed --wave next

fraud-lab-live-analysis: prepare
	@provider=$$(awk -F= '$$1 == "FRAUD_RULE_DISCOVERY_PROVIDER" { value = substr($$0, index($$0, "=") + 1); gsub(/^"|"$$/, "", value); print value; exit }' .env); \
	if [ "$$provider" != "orchestrate" ]; then \
		echo "fraud-lab-live-analysis requires FRAUD_RULE_DISCOVERY_PROVIDER=orchestrate in .env" >&2; \
		exit 2; \
	fi; \
	base_url=$$(awk -F= '$$1 == "GLARAMARA_PUBLIC_ORIGIN" { value = substr($$0, index($$0, "=") + 1); gsub(/^"|"$$/, "", value); print value; exit }' .env); \
	python3 deployment/fraud_lab_live_analysis.py --base-url "$$base_url"

logs: prepare
	$(COMPOSE) logs --tail="$${LOG_TAIL:-200}"

reset: prepare
	@./deployment/reset.sh

test-deployment:
	python3 -m unittest discover -s deployment/tests -v

