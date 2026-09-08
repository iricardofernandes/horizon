# Horizon — root orchestration.
#
# There is no shared task graph: each project is independent (ADR 0001), so this
# Makefile shells out per project rather than sharing state between them.

PROJECTS_JSON := scripts/modules.json
SERVICES := identity catalog inventory sales webhooks

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

.PHONY: boundaries
boundaries: ## Verify module isolation
	@node scripts/check-boundaries.mjs

.PHONY: check
check: boundaries lint typecheck test ## Everything CI runs, locally

.PHONY: keys
keys: ## Generate Ed25519 development keys into a gitignored path
	@bash infra/scripts/generate-keys.sh

# --- platform ----------------------------------------------------------------
COMPOSE := docker compose -f infra/docker-compose.yml --env-file infra/.env

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
	@$(COMPOSE) -f infra/docker-compose.apps.yml up -d --build --wait

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
	@echo "not yet implemented — phase 8 (see docs/plan.md)" && exit 1
