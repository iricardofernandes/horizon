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

# --- phase 2 -----------------------------------------------------------------
.PHONY: up
up: ## Start the local platform (phase 2)
	@echo "not yet implemented — phase 2 (see docs/plan.md)" && exit 1

.PHONY: down
down: ## Stop the local platform (phase 2)
	@echo "not yet implemented — phase 2 (see docs/plan.md)" && exit 1

.PHONY: smoke
smoke: ## Verify the local platform end to end (phase 2)
	@echo "not yet implemented — phase 2 (see docs/plan.md)" && exit 1

# --- phase 8 -----------------------------------------------------------------
.PHONY: demo
demo: ## Seed a tenant and run the golden path (phase 8)
	@echo "not yet implemented — phase 8 (see docs/plan.md)" && exit 1
