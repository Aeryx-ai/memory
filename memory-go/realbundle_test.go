package memory

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestRealBundle runs against the user's own bundle when it exists: Check
// must pass (index parity over every directory), every concept must round
// trip byte for byte, and the context render must equal what the Node CLI
// prints for this repository. Skipped in CI.
func TestRealBundle(t *testing.T) {
	root := ResolveRoot("", os.Getenv)
	b := New(root)
	if !b.Exists() {
		t.Skip("no bundle at " + root)
	}
	r, err := Check(b)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range r.Problems {
		t.Errorf("check: %s: %s", p.Rel, p.Problem)
	}
	dirs, _ := b.Dirs()
	n, diff := 0, 0
	for _, d := range dirs {
		entries, _ := b.ListConcepts(d)
		for _, e := range entries {
			text, _ := b.Read(e.Rel)
			n++
			if RenderConcept(e.Concept) != text {
				diff++
				t.Logf("round trip differs: %s", e.Rel)
			}
		}
	}
	t.Logf("%d concepts, %d differ on round trip", n, diff)
	if diff > 0 {
		t.Errorf("%d concepts do not round trip; see log", diff)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Log("node not on PATH; skipping the context comparison")
		return
	}
	repo, _ := filepath.Abs("..")
	cmd := exec.Command(node, filepath.Join(repo, "bin", "memory.mjs"), "context", "--cwd", repo)
	want, err := cmd.Output()
	if err != nil {
		t.Fatalf("node context: %v", err)
	}
	id, _ := ProjectIDFor(repo)
	got, err := RenderContext(b, ContextOptions{ProjectID: id})
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Errorf("context differs from the Node CLI for %s: %s", id, firstDiff(got, string(want)))
	}
}

func firstDiff(a, b string) string {
	al, bl := strings.Split(a, "\n"), strings.Split(b, "\n")
	for i := range min(len(al), len(bl)) {
		if al[i] != bl[i] {
			return "line " + strconv.Itoa(i+1) + ": go " + al[i] + " | node " + bl[i]
		}
	}
	return "lengths differ"
}
