# Horizon — root orchestration.
#
# There is no shared task graph: each project is independent (ADR 0001), so this
# Makefile shells out per project rather than sharing state between them.

PROJECTS_JSON := scripts/modules.json
SERVICES := identity catalog inventory sales webhooks parties financial treasury ledger procurement fiscal crm reporting files agent knowledge

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

.PHONY: verify-phase43-sources
verify-phase43-sources: ## Verify retained Phase 43 candidate sources and response XSD bytes
	@cd fiscal && npm run phase43:verify-sources

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
	@# `--wait` fails on a container that exits, even with 0, when nothing depends on it, so
	@# the bucket setup runs on its own and must succeed.
	@$(COMPOSE) up -d --wait $$($(COMPOSE) config --services | grep -vx minio-init)
	@$(COMPOSE) run --rm minio-init >/dev/null
	@echo
	@echo "  gateway     http://localhost:$${HORIZON_KONG_PROXY_PORT:-8000}"
	@echo "  grafana     http://localhost:$${HORIZON_GRAFANA_PORT:-3300}   (admin/admin)"
	@echo "  jaeger      http://localhost:$${HORIZON_JAEGER_PORT:-16686}"
	@echo "  prometheus  http://localhost:$${HORIZON_PROMETHEUS_PORT:-9090}"
	@echo "  rabbitmq    http://localhost:$${HORIZON_RABBITMQ_UI_PORT:-15672}  (horizon/horizon)"
	@echo "  verdaccio   http://localhost:$${HORIZON_VERDACCIO_PORT:-4873}"
	@echo
	@echo "  next: make smoke"

# A dozen `npm ci` at once fail at random (ETXTBSY, SIGBUS): images build a few at a time.
HORIZON_BUILD_BATCH ?= 4

.PHONY: build-apps
build-apps: infra/.env ## Build Horizon's images, HORIZON_BUILD_BATCH at a time
	@HORIZON_RUNTIME_UID=$(HORIZON_RUNTIME_UID) HORIZON_RUNTIME_GID=$(HORIZON_RUNTIME_GID) \
		$(COMPOSE) -f infra/docker-compose.apps.yml config --format json \
		| node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{const {services}=JSON.parse(s);console.log(Object.keys(services).filter((name)=>services[name].build).sort().join("\n"))})' \
		| HORIZON_RUNTIME_UID=$(HORIZON_RUNTIME_UID) HORIZON_RUNTIME_GID=$(HORIZON_RUNTIME_GID) \
			xargs -n $(HORIZON_BUILD_BATCH) $(COMPOSE) -f infra/docker-compose.apps.yml build

.PHONY: up-apps
up-apps: infra/.env infra/keys/public kong-config build-apps ## Start the platform plus Horizon's own services
	@HORIZON_RUNTIME_UID=$(HORIZON_RUNTIME_UID) HORIZON_RUNTIME_GID=$(HORIZON_RUNTIME_GID) \
		$(COMPOSE) -f infra/docker-compose.apps.yml up -d --wait
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

.PHONY: up-ai
up-ai: infra/.env ## Run the local embedding model and point the document index at it (Phase 74)
	@$(COMPOSE) -f infra/docker-compose.apps.yml --profile ai up -d tei
	@HORIZON_KNOWLEDGE_EMBEDDER=tei HORIZON_RUNTIME_UID=$(HORIZON_RUNTIME_UID) HORIZON_RUNTIME_GID=$(HORIZON_RUNTIME_GID) \
		$(COMPOSE) -f infra/docker-compose.apps.yml up -d --no-deps knowledge

.PHONY: eval-retrieval
eval-retrieval: infra/.env ## Measure recall@5 of document search with the local model and store it (Phase 75)
	@$(COMPOSE) -f infra/docker-compose.apps.yml --profile ai up -d tei
	@until curl -sf http://127.0.0.1:8088/health >/dev/null; do sleep 3; done
	@cd knowledge && RETRIEVAL_EMBEDDER=tei TEI_URL=http://127.0.0.1:8088 \
		RETRIEVAL_RECORD=$(CURDIR)/docs/drills npx vitest run --config vitest.config.e2e.mts test/retrieval.e2e-spec.ts

.PHONY: up-scanner
up-scanner: infra/.env ## Start ClamAV and point the files module at it (Phase 65)
	@$(COMPOSE) --profile scanner up -d --wait clamav
	@HORIZON_FILES_SCANNER=clamav HORIZON_RUNTIME_UID=$(HORIZON_RUNTIME_UID) HORIZON_RUNTIME_GID=$(HORIZON_RUNTIME_GID) \
		$(COMPOSE) -f infra/docker-compose.apps.yml up -d --no-deps files

.PHONY: test-alerts
test-alerts: ## Check and unit-test the Prometheus alert rules with promtool
	@docker run --rm -v "$(CURDIR)/infra/observability/rules":/rules -w /rules \
		--entrypoint promtool prom/prometheus:v3.7.3 check rules fiscal.rules.yml sales.rules.yml slo.rules.yml phase-n.rules.yml
	@docker run --rm -v "$(CURDIR)/infra/observability/rules":/rules -w /rules \
		--entrypoint promtool prom/prometheus:v3.7.3 test rules fiscal.rules.test.yml sales.rules.test.yml slo.rules.test.yml phase-n.rules.test.yml

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

.PHONY: backup-now
backup-now: ## Take a PostgreSQL base backup now (Phase 69)
	@docker exec horizon-postgres-backup sh /scripts/basebackup.sh once

.PHONY: retention-now
retention-now: ## Run one retention pass now and print its log (Phase 69)
	@docker exec -e RETENTION_ONCE=true horizon-retention node dist/main.js

.PHONY: phase-n-drill
phase-n-drill: ## Attack Phase N through Kong and record what held (Phase 78)
	@node scripts/phase-n-drill.mjs

.PHONY: phase-n-golden-path
phase-n-golden-path: ## Walk Phase N end to end; AI=on after make up-ai (Phase 78)
	@node scripts/phase-n-golden-path.mjs --ai $${AI:-off}

.PHONY: phase-m-golden-path
phase-m-golden-path: ## Walk Phase M end to end and write its record to docs/drills (Phase 70)
	@node scripts/phase-m-golden-path.mjs

.PHONY: tax-oracle
tax-oracle: ## Put the IBS/CBS package to the official calculator; DOWNLOAD=1 fetches it (Phase 84)
	@node scripts/tax-oracle.mjs $(if $(DOWNLOAD),--download,)

.PHONY: probe-user
probe-user: ## Create the synthetic probe's own account in the demo workspace (Phase 70)
	@node scripts/probe-user.mjs

.PHONY: restore-drill
restore-drill: ## Restore the whole stack from backups beside the live one, verify it, store the evidence (Phase 69)
	@scripts/restore-drill.sh

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
