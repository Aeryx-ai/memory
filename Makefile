# build is a no-op (no compile step); kept so every target exists.
.PHONY: build test install redeploy check lint migrate
build:
	@node -e "import('./src/cli.mjs').then(()=>console.log('ok'))"
test:
	npm test
	@[ -d "$${MEMORY_DIR:-$$HOME/.agents/memory}" ] && node bin/memory.mjs check || true
install:
	npm install -g .
	pi install "$(CURDIR)" --approve
redeploy: install
check: test
lint:
	node --check bin/memory.mjs && for f in src/*.mjs src/migrate/*.mjs extensions/*.mjs; do node --check "$$f" || exit 1; done
migrate:
	node bin/memory.mjs migrate all
