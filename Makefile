# Hermes Agent — convenience Make targets for Phase 5 dashboard workflows.
# Everything is scoped to the dashboard + observability stack. Python and
# test orchestration live in pyproject.toml / pytest, not here.

.PHONY: help dashboard-install dashboard-dev dashboard-build dashboard-test \
        dashboard-clean phoenix-up phoenix-down phoenix-logs gateway-restart \
        gateway-logs

help:
	@echo "Hermes make targets:"
	@echo "  dashboard-install    npm install in ./dashboard"
	@echo "  dashboard-dev        Vite dev server at :5173 (proxies to gateway)"
	@echo "  dashboard-build      Build + copy bundle to api_server_static/"
	@echo "  dashboard-test       Run Vitest component tests"
	@echo "  dashboard-clean      Remove node_modules, dist, api_server_static"
	@echo "  phoenix-up           Start Arize Phoenix observability sidecar"
	@echo "  phoenix-down         Stop Phoenix (keeps volume)"
	@echo "  phoenix-logs         Tail Phoenix container logs"
	@echo "  gateway-restart      Restart Hermes gateway via launchctl"
	@echo "  gateway-logs         Tail gateway.log"

dashboard-install:
	cd dashboard && npm install

dashboard-dev: dashboard-install
	cd dashboard && npm run dev

dashboard-build: dashboard-install
	cd dashboard && npm run build:bundle

dashboard-test:
	cd dashboard && npm run test

dashboard-clean:
	rm -rf dashboard/node_modules dashboard/dist \
	       gateway/platforms/api_server_static \
	       dashboard/src/routeTree.gen.ts \
	       dashboard/tsconfig.tsbuildinfo

# Observability (R4) — opt-in Phoenix sidecar
phoenix-up:
	docker compose -f docker-compose.observability.yml up -d
	@echo ""
	@echo "Phoenix UI:     http://localhost:6006"
	@echo "OTLP gRPC:      http://localhost:4317"
	@echo "OTLP HTTP:      http://localhost:4318"
	@echo ""
	@echo "Next: export HERMES_OTLP_ENDPOINT=http://localhost:4317"
	@echo "      make gateway-restart"

phoenix-down:
	docker compose -f docker-compose.observability.yml down

phoenix-logs:
	docker compose -f docker-compose.observability.yml logs -f phoenix

# Gateway lifecycle
gateway-restart:
	launchctl kickstart -k "gui/$$(id -u)/ai.hermes.gateway"
	@echo "Gateway restarted. Tail logs: make gateway-logs"

gateway-logs:
	tail -f ~/.hermes/logs/gateway.log

# ── llama-server (local LLM inference) ────────────────────────────────
llama-start:
	@echo "Stopping LM Studio if running..."
	-@osascript -e 'quit app "LM Studio"' 2>/dev/null || true
	@sleep 2
	@cp scripts/llama-server/com.llama-server.hermes.plist ~/Library/LaunchAgents/
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.llama-server.hermes.plist
	@echo "llama-server starting on port 1234. Check: make llama-health"

llama-stop:
	-launchctl bootout gui/$$(id -u)/com.llama-server.hermes
	@echo "llama-server stopped"

llama-restart: llama-stop
	@sleep 2
	$(MAKE) llama-start

llama-logs:
	tail -f ~/.hermes/logs/llama-server.stderr.log

llama-health:
	@curl -s http://127.0.0.1:1234/health | python3 -m json.tool

llama-metrics:
	@curl -s http://127.0.0.1:1234/metrics
