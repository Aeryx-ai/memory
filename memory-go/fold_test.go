package memory

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPromptsGolden(t *testing.T) {
	c := loadCases(t).Prompts
	if got := ObserverPrompt(c.Input.Reflections, c.Input.Observations, c.Input.Delta); got != c.Observer {
		t.Errorf("observer prompt differs\n--- got ---\n%s\n--- want ---\n%s", got, c.Observer)
	}
	if got := ReflectorPrompt(c.Input.Reflections, c.Input.Observations); got != c.Reflector {
		t.Errorf("reflector prompt differs\n--- got ---\n%s\n--- want ---\n%s", got, c.Reflector)
	}
}

type fakeSummarizer struct {
	out string
	err error
	n   int
}

func (f *fakeSummarizer) Summarize(prompt string) (string, error) {
	f.n++
	if strings.Contains(prompt, "You distill") {
		id := bareHexID.FindString(prompt)
		return "Keep pnpm <- " + id + "\n", nil
	}
	return f.out, f.err
}

func TestFoldStateAndGiveUp(t *testing.T) {
	b := initBundle(t)
	fx, _ := filepath.Abs(filepath.Join(fixtures, "pi.jsonl"))
	now := time.Date(2026, 1, 5, 8, 0, 0, 0, time.UTC)
	o := FoldOptions{Session: "pi:session/01a0457b", Actor: "pi/kimi-k3", Transcript: fx, Format: "pi", ProjectID: "github.com/a/b", Settings: FoldSettings{ObserveAfterTokens: 8000}, Now: now}
	due, reason, _ := FoldDue(b, o)
	if due || !strings.HasSuffix(reason, "tokens pending") {
		t.Errorf("under threshold: %v %q", due, reason)
	}
	o.Settings.ObserveAfterTokens = 1
	if due, _, _ := FoldDue(b, o); !due {
		t.Error("over threshold is due")
	}
	o.Summarizer = &fakeSummarizer{out: "[high] User requires pnpm, never npm | a1b2c3d4\n"}
	st, err := RunFoldJob(b, o)
	if err != nil || st.Observations != 1 || st.Reason != "" {
		t.Fatalf("%+v %v", st, err)
	}
	statePath, _ := b.StatePath("pi-session-01a0457b.json")
	raw, _ := os.ReadFile(statePath)
	var state map[string]any
	json.Unmarshal(raw, &state)
	info, _ := os.Stat(fx)
	if int64(state["transcriptBytes"].(float64)) != info.Size() || state["rel"] == nil || state["foldedAt"] == nil {
		t.Errorf("state %s", raw)
	}
	if !strings.HasPrefix(state["rel"].(string), "projects/github.com/a/b/session-summaries/20260105T080000Z-pi-kimi-k3") {
		t.Errorf("rel %v", state["rel"])
	}
	if due, _, _ := FoldDue(b, o); due {
		t.Error("nothing pending after a fold")
	}
	failing := FoldOptions{Session: "pi:session/fail", Actor: "pi/kimi-k3", Transcript: fx, Format: "pi", ProjectID: "github.com/a/b", Settings: FoldSettings{ObserveAfterTokens: 1}, Now: now, Summarizer: &fakeSummarizer{err: Errorf(CodeSync, "boom")}}
	for i := range 3 {
		st, _ := RunFoldJob(b, failing)
		raw, _ := os.ReadFile(filepath.Join(b.Root, ".state", "pi-session-fail.json"))
		json.Unmarshal(raw, &state)
		if st.Error == "" || int(state["failures"].(float64)) != i+1 {
			t.Errorf("attempt %d: %+v %s", i, st, raw)
		}
		if i < 2 && state["transcriptBytes"].(float64) != 0 {
			t.Error("checkpoint held until the give up")
		}
	}
	if state["transcriptBytes"].(float64) == 0 || !strings.Contains(state["lastError"].(map[string]any)["message"].(string), "delta abandoned") {
		t.Errorf("third failure abandons the delta: %v", state)
	}
	fin := FoldOptions{Session: "pi:session/01a0457b", Actor: "pi/kimi-k3", Transcript: fx, Format: "pi", ProjectID: "github.com/a/b", Finalize: true, Now: now.Add(time.Hour)}
	if st, err := RunFoldJob(b, fin); err != nil || st.Reason != "" {
		t.Fatalf("finalize without summarizer promotes: %+v %v", st, err)
	}
	d, _ := b.Dir("github.com/a/b")
	entries, _ := b.ListConcepts(d)
	for _, e := range entries {
		if IsSessionSummaryFor(e.Concept, "pi:session/01a0457b") && e.Concept.Status != "stable" {
			t.Error("finalize marks stable")
		}
	}
	if st, _ := RunFoldJob(b, FoldOptions{Session: "pi:session/none", Actor: "pi/k", Transcript: fx, ProjectID: "github.com/a/b", Now: now}); st.Reason != "no summarizer" {
		t.Errorf("no summarizer, no finalize: %+v", st)
	}
	if st, _ := RunFoldJob(b, FoldOptions{Session: "pi:session/none", Actor: "pi/k", Transcript: "/nope", ProjectID: "github.com/a/b", Now: now, Summarizer: &fakeSummarizer{}}); st.Reason != "no transcript" {
		t.Errorf("missing transcript: %+v", st)
	}
	if err := MarkFoldError(b, "pi:session/marked", "spawn failed", now); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(filepath.Join(b.Root, ".state", "pi-session-marked.json"))
	if !strings.Contains(string(raw), `"lastError":{"at":"2026-01-05T08:00:00.000Z","message":"spawn failed"}`) {
		t.Errorf("mark: %s", raw)
	}
}

func TestExecSummarizer(t *testing.T) {
	s := ExecSummarizer(`sh -c 'cat "$MEMORY_PROMPT_FILE" | tr a-z A-Z; cat -'`)
	out, err := s.Summarize("hello")
	if err != nil || out != "HELLOhello" {
		t.Errorf("%q %v", out, err)
	}
	if _, err := ExecSummarizer("sh -c 'exit 7'").Summarize("x"); err == nil {
		t.Error("non-zero exit is an error")
	}
}

// TestFoldJobRunErrorSurfacesInStatus proves Job.Run's error is no longer
// silently discarded on the promote-to-stable path (fold's finalize with no
// summarizer, and the same treatment at the end of a full fold): a bundle
// with no git repository, so Job.Run's commit step fails, still counts the
// fold as done but reports the failure in FoldStatus.Error.
func TestFoldJobRunErrorSurfacesInStatus(t *testing.T) {
	b := New(filepath.Join(t.TempDir(), "memory")) // no Init: no .git, so Job.Run's commit fails
	dir, _ := b.Dir("github.com/a/b")
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c, err := Create(CreateInput{Type: "Session Summary", Title: "x", Actor: "pi/k", At: at, Sources: []Source{{Resource: "pi:session/x"}}, Body: RenderSummaryBody(SummaryBody{})})
	if err != nil {
		t.Fatal(err)
	}
	rel := b.ConceptRel(dir, "Session Summary", "x-summary")
	if err := b.WriteConcept(rel, c); err != nil {
		t.Fatal(err)
	}
	fin := FoldOptions{Session: "pi:session/x", Actor: "pi/k", ProjectID: "github.com/a/b", Finalize: true, Now: at.Add(time.Hour)}
	st, err := RunFoldJob(b, fin)
	if err != nil {
		t.Fatal(err)
	}
	if st.Status != "folded" || !strings.Contains(st.Error, "write completion:") {
		t.Errorf("fold status = %+v, want folded with a write completion error", st)
	}
}

// TestExecSummarizerCapsOutput proves the cap is enforced while the child is
// still writing (a limitedWriter failing mid-copy), not by buffering the
// whole 20MB and checking afterward: a child that would never stop on its
// own (yes) still returns promptly because Write starts failing once the
// buffer would cross 16MB.
func TestExecSummarizerCapsOutput(t *testing.T) {
	_, err := ExecSummarizer(`sh -c 'yes | head -c 20000000'`).Summarize("x")
	if err == nil || err.Error() != "summarizer: output over 16MB" {
		t.Errorf("got %v, want %q", err, "summarizer: output over 16MB")
	}
}
