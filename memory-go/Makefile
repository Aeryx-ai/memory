.PHONY: build test lint check install redeploy
build:
	CGO_ENABLED=0 go build ./...
test:
	go test -race ./...
lint:
	go vet ./...
	test -z "$$(gofmt -l .)" || { gofmt -l .; exit 1; }
check: lint test
install: build
redeploy: install
