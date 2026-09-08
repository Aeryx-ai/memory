package memory

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestContextAndRecallGolden(t *testing.T) {
	b := goldenBundle(t)
	ops, _ := loadOps(t)
	for _, o := range ops {
		switch o.Cmd {
		case "context":
			want, _ := os.ReadFile(filepath.Join(goldenDir, "context", o.Out+".txt"))
			got, err := RenderContext(b, ContextOptions{ProjectID: o.Project, Session: o.Session, Summaries: o.Summaries, Budget: o.Budget})
			if err != nil {
				t.Fatal(err)
			}
			got = strings.ReplaceAll(got, b.Root, "<TMP>/memory")
			if got != string(want) {
				t.Errorf("context %s differs\n--- got ---\n%s\n--- want ---\n%s", o.Out, got, want)
			}
		case "recall":
			want, _ := os.ReadFile(filepath.Join(goldenDir, "recall", o.Out+".json"))
			hits, err := Recall(b, o.Project, o.Type, o.Query, o.Deprecated)
			if err != nil {
				t.Fatal(err)
			}
			if got := hitsJSON(hits); got != string(want) {
				t.Errorf("recall %s differs\n got %s\nwant %s", o.Out, got, want)
			}
		}
	}
}

func hitsJSON(hits []Hit) string {
	if hits == nil {
		hits = []Hit{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode(hits)
	return buf.String()
}

// The budget path is not in the goldens: the head carries the bundle's
// absolute path, so the byte count a budget cuts at depends on where the
// bundle lives. This test pins the two behaviors instead: whole summaries
// drop oldest first, then the last one is cut with the marker.
func TestContextBudget(t *testing.T) {
	b := initBundle(t)
	d, _ := b.Dir("github.com/a/b")
	at := time.Date(2026, 1, 4, 11, 0, 0, 0, time.UTC)
	long := strings.Repeat("x", 300)
	for i := range 3 {
		res, err := Summarize(b, d, "pi/k", at.Add(time.Duration(i)*time.Hour), "pi:session/s"+strconv.Itoa(i), "# Reflections\n\n# Observations\n[00000000000"+strconv.Itoa(i)+"] 2026-01-04 10:59 [high] "+long+"\n")
		if err != nil {
			t.Fatal(err)
		}
		res.Job.Run(b)
	}
	full, _ := RenderContext(b, ContextOptions{ProjectID: "github.com/a/b", Summaries: 3})
	if strings.Count(full, "### ") != 3 {
		t.Fatalf("three summaries expected:\n%s", full)
	}
	one, _ := RenderContext(b, ContextOptions{ProjectID: "github.com/a/b", Summaries: 3, Budget: len(full) - 100})
	if strings.Count(one, "### ") != 2 || strings.Contains(one, "[truncated]") || !strings.Contains(one, "pi:session/s2") {
		t.Errorf("one summary dropped, newest kept, no truncation:\n%s", one)
	}
	head := full[:strings.Index(full, "### ")]
	tail := "</memory-context>\n"
	budget := len(head) + len(tail) + 50
	cut, _ := RenderContext(b, ContextOptions{ProjectID: "github.com/a/b", Summaries: 3, Budget: budget})
	if strings.Count(cut, "### ") != 1 || !strings.HasSuffix(cut, "[truncated]\n"+tail) {
		t.Errorf("last summary truncated with the marker:\n%s", cut)
	}
	if len(cut) > budget+len("[truncated]\n") {
		t.Errorf("cut render is %d bytes for budget %d", len(cut), budget)
	}
}

// The golden tree's session-summary ids were normalized per file when the
// fixtures were written (test/golden/gen.mjs's copyTree calls normalizeIds
// once per file), so every session summary in project alpha reuses the same
// two labels, a00000000001 and a00000000002. The oldest file by rel order,
// s-old, holds both as its own reflection and observation and has no
// transcript source, so any lookup by either label resolves there first with
// no reason and no entries: that is the one lookup this bundle can prove.
func TestRecallObservation(t *testing.T) {
	b := goldenBundle(t)
	hit, err := RecallObservation(b, "github.com/golden/alpha", "a00000000002", "/nowhere")
	if err != nil || hit.ID != "a00000000002" || hit.Reason != "" || len(hit.Entries) != 0 {
		t.Fatalf("%+v %v", hit, err)
	}
	if obs, ok := hit.Line.(Observation); !ok || obs.Content != "Older summary" {
		t.Errorf("line = %+v, want the s-old observation", hit.Line)
	}
	if _, err := RecallObservation(b, "github.com/golden/alpha", "ffffffffffff", "/nowhere"); CodeOf(err) != CodeNotFound {
		t.Error("unknown id is not found")
	}
}

// The golden bundle never exercises the refusal itself (see above), so this
// builds a session summary with a transcript source outside home directly.
func TestRecallObservationTranscriptOutsideHome(t *testing.T) {
	b := initBundle(t)
	dir, _ := b.Dir("github.com/a/b")
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c, err := Create(CreateInput{
		Type: "Session Summary", Title: "test", Actor: "pi/k", At: at,
		Sources: []Source{{Resource: "pi:session/x"}, {Resource: "/outside/home/transcript.jsonl", Title: "transcript"}},
		Body:    "# Reflections\n\n# Observations\n[a00000000099] 2026-01-01 00:00 [high] test content\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	rel := b.ConceptRel(dir, "Session Summary", "test-summary")
	if err := b.WriteConcept(rel, c); err != nil {
		t.Fatal(err)
	}
	hit, err := RecallObservation(b, "github.com/a/b", "a00000000099", b.Root)
	if err != nil || hit.ID != "a00000000099" || hit.Reason != "transcript outside home" || len(hit.Entries) != 0 {
		t.Fatalf("%+v %v", hit, err)
	}
}
