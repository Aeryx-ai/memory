# build is a no-op (no compile step); kept so every target exists.
.PHONY: build test install redeploy check lint migrate goldens go-test
build:
	@node -e "import('./src/cli.mjs').then(()=>console.log('ok'))"
	$(MAKE) -C memory-go build
goldens:
	node test/golden/gen.mjs
go-test:
	$(MAKE) -C memory-go test
test: goldens
	@git diff --quiet -- memory-go/testdata || { echo "goldens drift: memory-go/testdata changed after regeneration; commit the regenerated tree with the src/ change"; git --no-pager diff --stat -- memory-go/testdata; exit 1; }
	npm test
	$(MAKE) -C memory-go test
	@[ -d "$${MEMORY_DIR:-$$HOME/.agents/memory}" ] && node bin/memory.mjs check || true
install:
	npm install -g .
	pi install "$(CURDIR)" --approve
redeploy: install
check: test
lint:
	node --check bin/memory.mjs && for f in src/*.mjs src/migrate/*.mjs extensions/*.mjs test/golden/*.mjs; do node --check "$$f" || exit 1; done
	$(MAKE) -C memory-go lint
migrate:
	node bin/memory.mjs migrate all
