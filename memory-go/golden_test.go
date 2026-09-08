package memory

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

// The summarizer commands from test/golden/gen.mjs, keyed by name. dup and
// leaky cite the claude fixture's first entry uuid directly: gen.mjs derives
// it the same way (see CLAUDE_ID there), and it never changes since the
// fixture is checked in.
var summarizers = map[string]string{
	"observer": `sh -c 'grep -q "You distill" - && echo "Keep pnpm <- $(cat "$MEMORY_PROMPT_FILE" | grep -o "\[[a-f0-9]\{12\}\]" | head -1 | tr -d "[]")" || echo "[high] User requires pnpm, never npm | a1b2c3d4"'`,
	"dup":      `sh -c 'echo "[high] First observation | 2a55d202-0256-4c6a-acb8-d2c40a35847f"; echo "[medium] Second observation | 2a55d202-0256-4c6a-acb8-d2c40a35847f"'`,
	"leaky":    `sh -c 'echo "[high] Key is AKIAIOSFODNN7EXAMPLE | 2a55d202-0256-4c6a-acb8-d2c40a35847f"'`,
	"failing":  `sh -c 'exit 7'`,
}

type op struct {
	At           string         `json:"at"`
	Cmd          string         `json:"cmd"`
	Project      string         `json:"project"`
	Root         bool           `json:"root"`
	Actor        string         `json:"actor"`
	Type         string         `json:"type"`
	Title        string         `json:"title"`
	Description  *string        `json:"description"`
	Tags         *string        `json:"tags"`
	Source       []string       `json:"source"`
	Status       *string        `json:"status"`
	Body         *string        `json:"body"`
	Key          string         `json:"key"`
	Session      string         `json:"session"`
	Transcript   string         `json:"transcript"`
	Format       string         `json:"format"`
	Summarizer   string         `json:"summarizer"`
	Finalize     bool           `json:"finalize"`
	Settings     map[string]int `json:"settings"`
	Summaries    int            `json:"summaries"`
	Budget       int            `json:"budget"`
	Query        string         `json:"query"`
	Deprecated   bool           `json:"deprecated"`
	Out          string         `json:"out"`
	Expect       int            `json:"expect"`
	ExpectStatus string         `json:"expectStatus"`
}

type opResult struct {
	I      int    `json:"i"`
	Cmd    string `json:"cmd"`
	Code   int    `json:"code"`
	Stdout string `json:"stdout"`
}

var hexID = regexp.MustCompile(`[a-f0-9]{12}`)

func hexOrDash(b byte) bool { return b == '-' || (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') }

// normalizeIDs mirrors gen.mjs: 12-hex ids renumbered per text in order of
// first appearance; a run touching another hex digit or a dash is part of
// something longer (a uuid segment) and is left alone. Every raw id seen is
// recorded in union when one is given, so text outputs quoting several
// files can be rewritten through applyIDs to agree with the files.
func normalizeIDs(text string, union map[string]string) string {
	seen := map[string]string{}
	return rewriteIDs(text, func(id string) string {
		if _, ok := seen[id]; !ok {
			seen[id] = fmt.Sprintf("a%011d", len(seen)+1) // never an integer to the YAML core schema
			if union != nil {
				if _, ok := union[id]; !ok {
					union[id] = seen[id]
				}
			}
		}
		return seen[id]
	})
}

func applyIDs(text string, union map[string]string) string {
	return rewriteIDs(text, func(id string) string {
		if n, ok := union[id]; ok {
			return n
		}
		return id
	})
}

func rewriteIDs(text string, f func(string) string) string {
	var b strings.Builder
	last := 0
	for _, m := range hexID.FindAllStringIndex(text, -1) {
		b.WriteString(text[last:m[0]])
		id := text[m[0]:m[1]]
		if (m[0] > 0 && hexOrDash(text[m[0]-1])) || (m[1] < len(text) && hexOrDash(text[m[1]])) {
			b.WriteString(id)
		} else {
			b.WriteString(f(id))
		}
		last = m[1]
	}
	b.WriteString(text[last:])
	return b.String()
}

type replay struct {
	t       *testing.T
	base    string
	b       *Bundle
	ops     []op
	results []opResult
	stop    map[string]bool   // op cmds this task does not run yet
	union   map[string]string // raw id to its per-file normalized form, filled by compareTree
	texts   map[string]string // context outputs by golden rel, compared after compareTree
}

func loadOps(t *testing.T) ([]op, []opResult) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(goldenDir, "ops.json"))
	if err != nil {
		t.Fatalf("goldens missing; run make goldens: %v", err)
	}
	var ops []op
	if err := json.Unmarshal(raw, &ops); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(filepath.Join(goldenDir, "results.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var results []opResult
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		var r opResult
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			t.Fatal(err)
		}
		results = append(results, r)
	}
	return ops, results
}

func newReplay(t *testing.T, stop ...string) *replay {
	t.Helper()
	base := t.TempDir()
	os.MkdirAll(filepath.Join(base, "transcripts"), 0o755)
	for _, f := range []string{"pi.jsonl", "claude.jsonl"} {
		raw, err := os.ReadFile(filepath.Join("..", "test", "fixtures", "transcripts", f))
		if err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(base, "transcripts", f), raw, 0o644)
	}
	ops, results := loadOps(t)
	r := &replay{t: t, base: base, b: New(filepath.Join(base, "memory")), ops: ops, results: results, stop: map[string]bool{}, union: map[string]string{}, texts: map[string]string{}}
	for _, s := range stop {
		r.stop[s] = true
	}
	return r
}

func (r *replay) at(o op) time.Time {
	tm, err := time.Parse(time.RFC3339Nano, o.At)
	if err != nil {
		r.t.Fatal(err)
	}
	return tm
}

func (r *replay) dir(o op) Dir {
	if o.Root || o.Project == "" {
		d, _ := r.b.Dir("")
		return d
	}
	d, err := r.b.Dir(o.Project)
	if err != nil {
		r.t.Fatal(err)
	}
	return d
}

func (r *replay) normalize(s string) string {
	return normalizeIDs(strings.ReplaceAll(s, r.base, "<TMP>"), r.union)
}

// run executes ops in order until one whose cmd is in stop; returns the
// index of the first op not run.
func (r *replay) run() int {
	for i, o := range r.ops {
		if r.stop[o.Cmd] {
			return i
		}
		code, stdout := r.exec(o)
		want := r.results[i]
		if code != want.Code {
			r.t.Fatalf("op %d %s: exit %d, want %d (%s)", i, o.Cmd, code, want.Code, stdout)
		}
		// Outputs that quote summaries carry ids; those are compared after the
		// tree walk fills the union (compareTexts). The rest compare here.
		if stdout != "" && want.Stdout != "" && o.Cmd != "context" && stdout != want.Stdout {
			r.t.Errorf("op %d %s: stdout\n got %s\nwant %s", i, o.Cmd, stdout, want.Stdout)
		}
	}
	return len(r.ops)
}

func codeOf(err error) int {
	if err == nil {
		return 0
	}
	if c := CodeOf(err); c != "" {
		return ExitCode(c)
	}
	return 1
}

func (r *replay) exec(o op) (int, string) {
	at := r.at(o)
	switch o.Cmd {
	case "init":
		if err := r.b.Init("", at); err != nil {
			return codeOf(err), ""
		}
		return 0, r.normalize(jsonLine(map[string]any{"root": r.b.Root}))
	case "remember":
		in := RememberInput{Type: o.Type, Title: o.Title, Description: o.Description, Sources: o.Source, Status: o.Status, Body: o.Body}
		if o.Tags != nil {
			var tags []string
			for _, t := range strings.Split(*o.Tags, ",") {
				if t = strings.TrimSpace(t); t != "" {
					tags = append(tags, t)
				}
			}
			if tags == nil {
				tags = []string{}
			}
			in.Tags = &tags
		}
		res, err := Remember(r.b, r.dir(o), o.Actor, at, in)
		if err != nil {
			return codeOf(err), ""
		}
		if _, err := res.Job.Run(r.b); err != nil {
			r.t.Fatal(err)
		}
		return 0, jsonLine(map[string]any{"rel": res.Rel, "created": res.Created})
	case "deprecate", "restore":
		fn := DeprecateKey
		if o.Cmd == "restore" {
			fn = RestoreKey
		}
		res, err := fn(r.b, r.dir(o), o.Actor, at, o.Key)
		if err != nil {
			return codeOf(err), ""
		}
		res.Job.Run(r.b)
		return 0, jsonLine(map[string]any{"rel": res.Rel, "status": res.Status})
	case "summarize":
		res, err := Summarize(r.b, r.dir(o), o.Actor, at, o.Session, *o.Body)
		if err != nil {
			return codeOf(err), ""
		}
		res.Job.Run(r.b)
		return 0, jsonLine(map[string]any{"rel": res.Rel, "created": res.Created})
	case "check":
		res, err := Check(r.b)
		if err != nil {
			return codeOf(err), ""
		}
		if !res.OK {
			return 4, jsonLine(res)
		}
		return 0, jsonLine(res)
	}
	return r.execLater(o)
}

// jsonLine is JSON.stringify(v) + "\n" for the small result objects the CLI
// prints, with the key order Node uses for each.
func jsonLine(v any) string {
	switch x := v.(type) {
	case map[string]any:
		keys := []string{"root", "rel", "created", "status", "ok", "problems"}
		var parts []string
		for _, k := range keys {
			if val, ok := x[k]; ok {
				b, _ := json.Marshal(val)
				parts = append(parts, `"`+k+`":`+string(b))
			}
		}
		return "{" + strings.Join(parts, ",") + "}\n"
	case CheckResult:
		problems := x.Problems
		if problems == nil {
			problems = []Problem{}
		}
		b, _ := json.Marshal(struct {
			OK       bool      `json:"ok"`
			Problems []Problem `json:"problems"`
		}{x.OK, problems})
		return string(b) + "\n"
	}
	b, _ := json.Marshal(v)
	return string(b) + "\n"
}

// compareTree diffs every file under the golden bundle against the replayed
// bundle, skipping paths for which skip returns true. Both sides are
// normalized the way gen.mjs normalizes: per file, walking files in
// CompareFold order of their names so the union map fills the same way.
func (r *replay) compareTree(skip func(rel string) bool) {
	r.t.Helper()
	goldenRoot := filepath.Join(goldenDir, "bundle")
	seen := map[string]bool{}
	var rels []string
	filepath.WalkDir(goldenRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rels = append(rels, filepath.ToSlash(strings.TrimPrefix(p, goldenRoot+string(filepath.Separator))))
		return nil
	})
	slices.SortStableFunc(rels, func(a, b string) int { return CompareFold(a, b) })
	for _, rel := range rels {
		seen[rel] = true
		want, _ := os.ReadFile(filepath.Join(goldenRoot, filepath.FromSlash(rel)))
		got, ok := r.b.Read(rel)
		if !ok {
			if !skip(rel) {
				r.t.Errorf("%s: missing in replay", rel)
			}
			continue
		}
		norm := r.normalize(got) // fills the union even for skipped files
		if skip(rel) {
			continue
		}
		if norm != string(want) {
			r.t.Errorf("%s differs\n--- got ---\n%s\n--- want ---\n%s", rel, norm, want)
		}
	}
	filepath.WalkDir(r.b.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			if name == ".git" || name == ".locks" || name == ".state" {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(name, ".tmp") {
			return nil
		}
		rel := filepath.ToSlash(strings.TrimPrefix(p, r.b.Root+string(filepath.Separator)))
		if !seen[rel] && !skip(rel) {
			r.t.Errorf("%s: extra file in replay", rel)
		}
		return nil
	})
}

// compareTexts compares the context outputs captured during the run, rewritten
// through the union the tree walk filled, against their golden files.
func (r *replay) compareTexts() {
	r.t.Helper()
	for rel, text := range r.texts {
		want, err := os.ReadFile(filepath.Join(goldenDir, rel))
		if err != nil {
			r.t.Errorf("%s: %v", rel, err)
			continue
		}
		if got := applyIDs(strings.ReplaceAll(text, r.base, "<TMP>"), r.union); got != string(want) {
			r.t.Errorf("%s differs\n--- got ---\n%s\n--- want ---\n%s", rel, got, want)
		}
	}
}

// TestGoldenReplayWrites runs every op before the first fold and compares
// the tree except the files ops after that point write or rewrite. Task 13
// adds the full replay.
func TestGoldenReplayWrites(t *testing.T) {
	r := newReplay(t, "fold", "context", "recall")
	r.run()
	alpha := "projects/github.com/golden/alpha/"
	r.compareTree(func(rel string) bool {
		if rel == alpha+"index.md" || rel == alpha+"log.md" || rel == alpha+"reference/after-the-failed-fold.md" {
			return true // rewritten or written by ops after the first fold
		}
		return strings.HasPrefix(rel, alpha+"session-summaries/20260105")
	})
}

func (r *replay) execLater(o op) (int, string) {
	switch o.Cmd {
	case "fold":
		fo := FoldOptions{Session: o.Session, Actor: o.Actor, Transcript: filepath.Join(r.base, "transcripts", o.Transcript), Format: o.Format, ProjectID: o.Project, Finalize: o.Finalize, Now: r.at(o)}
		fo.Settings = FoldSettings{o.Settings["observeAfterTokens"], o.Settings["reflectAfterTokens"], o.Settings["observationsMaxTokens"], o.Settings["observationsTargetTokens"], o.Settings["observerMaxTokens"]}
		if o.Summarizer != "" {
			fo.Summarizer = ExecSummarizer(summarizers[o.Summarizer])
		}
		due, reason, err := FoldDue(r.b, fo)
		if err != nil {
			r.t.Fatal(err)
		}
		var st FoldStatus
		if !due {
			st = FoldStatus{Status: "skipped", Reason: reason}
		} else if st, err = RunFoldJob(r.b, fo); err != nil {
			r.t.Fatal(err)
		} else if st.Reason != "" {
			st.Status = "skipped"
		}
		if o.ExpectStatus != "" && st.Status != o.ExpectStatus {
			r.t.Errorf("fold %s: status %s, want %s (%+v)", o.Session, st.Status, o.ExpectStatus, st)
		}
		return 0, ""
	case "context":
		text, err := RenderContext(r.b, ContextOptions{ProjectID: o.Project, Session: o.Session, Summaries: o.Summaries, Budget: o.Budget})
		if err != nil {
			return codeOf(err), ""
		}
		r.texts["context/"+o.Out+".txt"] = text // compared by compareTexts once the union is known
		return 0, text
	case "recall":
		hits, err := Recall(r.b, o.Project, o.Type, o.Query, o.Deprecated)
		if err != nil {
			return codeOf(err), ""
		}
		got := hitsJSON(hits)
		want, _ := os.ReadFile(filepath.Join(goldenDir, "recall", o.Out+".json"))
		if got != string(want) {
			r.t.Errorf("recall %s differs\n got %s\nwant %s", o.Out, got, want)
		}
		return 0, got
	}
	r.t.Fatalf("op %s not implemented", o.Cmd)
	return 1, ""
}

func TestGoldenReplayFull(t *testing.T) {
	r := newReplay(t)
	r.run()
	r.compareTree(func(string) bool { return false })
	r.compareTexts()
}
