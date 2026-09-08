# memory-go

Go SDK for the memory bundle. Reads and writes the same OKF bundle as the `memory` CLI, byte for byte, so a Go harness needs no Node runtime.

```go
import memory "github.com/aeryx-ai/memory/memory-go"

b := memory.New(memory.ResolveRoot("", os.Getenv))
dir, _ := memory.TargetDir(b, cwd, false)
res, err := memory.Remember(b, dir, "rudy/0.1", time.Now(), memory.RememberInput{Type: "Feedback", Title: "Use pnpm", Body: &body})
go res.Job.Run(b) // index, commit, push; never on the hot path
text, _ := memory.RenderContext(b, memory.ContextOptions{ProjectID: dir.ProjectID, Session: sessionID})
```

Fold takes a `Summarizer`; `ExecSummarizer(cmd)` runs a shell command the way the CLI does, and a harness supplies its own from its model client.

## Parity

`make goldens` at the repository root runs `test/golden/gen.mjs`, which executes `test/golden/ops.json` through the Node CLI and writes `testdata/golden/`. `go test` replays the same ops through this module and diffs every file. `make test` regenerates first and fails on drift, so a change to `src/` that alters bytes shows up in the same commit as its golden.

Known deviations, none of which cause the two writers to rewrite each other's files:

- Node preserves the key order of a hand-edited `generated` or `sources[]` object; Go writes `by, at` and `resource, id, title, last_modified`. A hand-edited file is reordered once on its first Go write.
- Node keeps a non-string tag as its YAML type; Go stringifies it.
- JavaScript objects list integer-like keys (`"123"`) first regardless of insertion order; Go's `yamlfm.Map` keeps file order. Only an unknown frontmatter key that looks like an integer is affected.
- `go.yaml.in/yaml/v3` refuses a raw DEL (U+007F) anywhere in frontmatter and treats a raw U+2028 as a line break, where `yaml@2.9.0` accepts both inside a double-quoted scalar. Go renders such values identically but cannot parse them back; `Check` reports the file. No concept the bundle holds carries either character.
- `.state/` checkpoints share keys, not bytes.

## Not ported

`doctor`, `migrate` and the pi and Claude Code adapters stay in Node; they are harness and legacy-store specific.
