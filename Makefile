# Horizon — root orchestration.
#
# There is no shared task graph: each project is independent (ADR 0001), so this
# Makefile shells out per project rather than sharing state between them.

PROJECTS_JSON := scripts/modules.json
SERVICES := identity catalog inventory sales webhooks parties financial treasury ledger procurement fiscal

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install dependencies in every project
	@node scripts/for-each-project.mjs "npm ci || npm install"

.PHONY: typecheck
typecheck: ## Typecheck every project
	@node scripts/for-each-project.mjs "npm run typecheck"

.PHONY: lint
lint: ## Lint and format-check every project
	@node scripts/for-each-project.mjs "npm run lint"

.PHONY: test
test: ## Run unit tests in every project
	@node scripts/for-each-project.mjs "npm test"

.PHONY: test-e2e
test-e2e: ## Run integration and e2e tests (needs a Docker socket)
	@node scripts/for-each-project.mjs "npm run test:e2e" --kinds service

.PHONY: test-phase7
test-phase7: ## Run the Inventory/Sales choreography against isolated infrastructure
	@cd inventory && npm run build
	@cd sales && npm run build
	@node scripts/phase7-e2e.mjs

.PHONY: test-phase10
test-phase10: ## Complete the golden path in Chromium and verify its joined trace
	@cd web && npm run test:browser

.PHONY: smoke-phase41
smoke-phase41: ## Verify Phase 41 safety through Kong (TENANT=<uuid>, optional DOCUMENT=<uuid>)
	@node scripts/phase41-smoke.mjs --tenant "$(TENANT)" \
		$(if $(DOCUMENT),--document "$(DOCUMENT)") \
		$(if $(EXPECT_EXPLANATION),--expect-explanation)

.PHONY: verify-phase42-sources
verify-phase42-sources: ## Verify retained Phase 42 NF-e manuals, notes and XSD bytes
	@cd fiscal && npm run phase42:verify-sources

.PHONY: setup-phase12
setup-phase12: ## Install the MCP debugger's least-privilege PostgreSQL wrappers
	@bash infra/scripts/install-mcp-debugger-db.sh

.PHONY: test-phase12
test-phase12: setup-phase12 ## Prove the MCP debugger role cannot read or write business data
	@cd tooling/mcp-debugger && npm run build && npm test
	@bash infra/scripts/verify-mcp-debugger-readonly.sh

.PHONY: boundaries
boundaries: ## Verify module isolation
	@node scripts/check-boundaries.mjs

.PHONY: check
check: boundaries lint typecheck test ## Fast code checks in every project

.PHONY: ci-local
ci-local: ## Run repository, build and integration gates before pushing
	@node scripts/ci-local.mjs

.PHONY: ci-local-full
ci-local-full: ## Also verify clean installs and build all Docker images
	@node scripts/ci-local.mjs --full

.PHONY: keys
keys: ## Generate Ed25519 development keys into a gitignored path
	@bash infra/scripts/generate-keys.sh

# --- platform ----------------------------------------------------------------
COMPOSE := docker compose -f infra/docker-compose.yml --env-file infra/.env
HORIZON_RUNTIME_UID := $(shell id -u)
HORIZON_RUNTIME_GID := $(shell id -g)

infra/.env:
	@cp infra/.env.example infra/.env

infra/keys/public:
	@bash infra/scripts/generate-keys.sh

.PHONY: kong-config
kong-config: infra/keys/public ## Render Kong's config from the template plus the dev keys
	@bash infra/scripts/render-kong-config.sh

.PHONY: up
up: infra/.env infra/keys/public kong-config ## Start the local platform and wait for health
	@$(COMPOSE) up -d --wait
	@echo
	@echo "  gateway     http://localhost:$${HORIZON_KONG_PROXY_PORT:-8000}"
	@echo "  grafana     http://localhost:$${HORIZON_GRAFANA_PORT:-3300}   (admin/admin)"
	@echo "  jaeger      http://localhost:$${HORIZON_JAEGER_PORT:-16686}"
	@echo "  prometheus  http://localhost:$${HORIZON_PROMETHEUS_PORT:-9090}"
	@echo "  rabbitmq    http://localhost:$${HORIZON_RABBITMQ_UI_PORT:-15672}  (horizon/horizon)"
	@echo "  verdaccio   http://localhost:$${HORIZON_VERDACCIO_PORT:-4873}"
	@echo
	@echo "  next: make smoke"

.PHONY: up-apps
up-apps: infra/.env infra/keys/public kong-config ## Start the platform plus Horizon's own services
	@HORIZON_RUNTIME_UID=$(HORIZON_RUNTIME_UID) HORIZON_RUNTIME_GID=$(HORIZON_RUNTIME_GID) \
		$(COMPOSE) -f infra/docker-compose.apps.yml up -d --build --wait
	@HORIZON_RUNTIME_UID=$(HORIZON_RUNTIME_UID) HORIZON_RUNTIME_GID=$(HORIZON_RUNTIME_GID) \
		$(COMPOSE) -f infra/docker-compose.apps.yml restart kong
	@for attempt in $$(seq 1 30); do \
		curl -fsS "http://localhost:$${HORIZON_KONG_ADMIN_PORT:-8001}/status" >/dev/null && exit 0; \
		sleep 1; \
	done; exit 1

.PHONY: up-fiscal
up-fiscal: infra/.env infra/keys/public kong-config ## Start the optional Fiscal API, worker and artifact store
	@HORIZON_RUNTIME_UID=$(HORIZON_RUNTIME_UID) HORIZON_RUNTIME_GID=$(HORIZON_RUNTIME_GID) \
		$(COMPOSE) -f infra/docker-compose.apps.yml --profile fiscal up -d --build --wait fiscal
	@$(COMPOSE) -f infra/docker-compose.apps.yml restart kong

.PHONY: down
down: ## Stop the platform, keeping data
	@$(COMPOSE) -f infra/docker-compose.apps.yml down

.PHONY: clean
clean: ## Stop the platform and delete its volumes
	@$(COMPOSE) -f infra/docker-compose.apps.yml down -v

.PHONY: smoke
smoke: ## Prove the platform works, not merely that it started
	@bash infra/scripts/smoke.sh

.PHONY: ps
ps: ## Show platform container status
	@$(COMPOSE) ps

.PHONY: logs
logs: ## Follow platform logs (make logs SERVICE=kong)
	@$(COMPOSE) logs -f $(SERVICE)

.PHONY: publish-contracts
publish-contracts: ## Build and publish @horizon/contracts to the local registry
	@cd contracts && npm run build && npm publish \
		--registry http://localhost:$${HORIZON_VERDACCIO_PORT:-4873} \
		--//localhost:$${HORIZON_VERDACCIO_PORT:-4873}/:_authToken=local-development

# --- phase 8 -----------------------------------------------------------------
.PHONY: demo
demo: ## Seed a tenant and run the golden path (phase 8)
	@cd identity && npm run build
	@cd catalog && npm run build
	@cd inventory && npm run build
	@cd sales && npm run build
	@cd webhooks && npm run build
	@cd parties && npm run build
	@cd financial && npm run build
	@cd treasury && npm run build
	@cd ledger && npm run build
	@cd procurement && npm run build
	@node scripts/demo.mjs

.PHONY: migrate-customers
migrate-customers: ## Register every legacy Sales customer as a party, keeping its id (ADR 0040)
	@cd sales && npm run build
	@cd parties && npm run build
	@node scripts/migrate-customers-to-parties.mjs

.PHONY: benchmark-golden-path
benchmark-golden-path: demo ## Measure the golden path with staged k6 arrival rates
	@bash infra/scripts/benchmark-golden-path.sh
