package memory

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSummaryGolden(t *testing.T) {
	cases := loadCases(t)
	for _, c := range cases.SummaryBodies {
		parsed := ParseSummaryBody(c.Input)
		got, _ := json.Marshal(parsed)
		want, _ := json.Marshal(json.RawMessage(c.Parsed))
		var g, w any
		json.Unmarshal(got, &g)
		json.Unmarshal(want, &w)
		if !reflect.DeepEqual(g, w) {
			t.Errorf("ParseSummaryBody(%q)\n got %s\nwant %s", c.Input, got, want)
		}
		if r := RenderSummaryBody(parsed); r != c.Rendered {
			t.Errorf("RenderSummaryBody differs\n got %q\nwant %q", r, c.Rendered)
		}
	}
	for _, c := range cases.Prune {
		kept, dropped := PruneObservations(c.Input.Observations, c.Input.Reflections, c.Input.MaxTokens, c.Input.TargetTokens)
		if !reflect.DeepEqual(kept, c.Expected.Observations) || !reflect.DeepEqual(nonNil(dropped), c.Expected.Dropped) {
			t.Errorf("prune %+v\n got %+v %v\nwant %+v %v", c.Input, kept, dropped, c.Expected.Observations, c.Expected.Dropped)
		}
	}
	for _, c := range cases.EstimateTokens {
		if got := EstimateTokens(c.Input); got != c.Expected {
			t.Errorf("EstimateTokens(%q) = %d, want %d", c.Input, got, c.Expected)
		}
	}
	for _, c := range cases.UTCMinute {
		tm, _ := time.Parse(time.RFC3339Nano, c.Input)
		if got := UTCMinute(tm); got != c.Expected {
			t.Errorf("UTCMinute(%s) = %q, want %q", c.Input, got, c.Expected)
		}
	}
	for _, c := range cases.SessionSlug {
		if got := sessionSlug(c.Input); got != c.Expected {
			t.Errorf("sessionSlug(%q) = %q, want %q", c.Input, got, c.Expected)
		}
	}
	if id := NewID(); len(id) != 12 || id == NewID() {
		t.Error("NewID is 12 hex chars and random")
	}
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func TestSessionSummaryRel(t *testing.T) {
	b := New(t.TempDir())
	d, _ := b.Dir("github.com/a/b")
	got, err := SessionSummaryRel(b, d, time.Date(2026, 9, 7, 16, 36, 26, 195_000_000, time.UTC), "claude-code/claude")
	if err != nil || got != "projects/github.com/a/b/session-summaries/20260907T163626Z-claude-code-claude.md" {
		t.Error(got, err)
	}
}

func TestRememberCreatesThenRevises(t *testing.T) {
	b := initBundle(t)
	root, _ := b.Dir("")
	at := time.Date(2026, 1, 2, 3, 5, 0, 0, time.UTC)
	res, err := Remember(b, root, "human:guy", at, RememberInput{Type: "User", Title: "Author name", Description: ptr("d"), Body: ptr("b\n")})
	if err != nil || !res.Created || res.Rel != "user/author-name.md" || res.Job.Message != "memory: remember Author name" {
		t.Fatalf("%+v %v", res, err)
	}
	res.Job.Run(b)
	res2, err := Remember(b, root, "pi/k", at.Add(time.Hour), RememberInput{Type: "User", Title: "Author name", Tags: ptr([]string{"x"})})
	if err != nil || res2.Created {
		t.Fatalf("revise: %+v %v", res2, err)
	}
	c, _ := b.ReadConcept(res2.Rel)
	if c.Body != "b\n" || c.Description != "d" || len(c.Tags) != 1 || c.Generated.By != "pi/k" {
		t.Errorf("revise kept body and description, replaced tags: %+v", c)
	}
	log, _ := b.Read("log.md")
	if want := "## 2026-01-02\n* **Creation**: [Author name](user/author-name.md) by human:guy\n* **Update**: [Author name](user/author-name.md) by pi/k\n"; !strings.Contains(log, want) {
		t.Errorf("log %q", log)
	}
	if _, err := Remember(b, root, "human:guy", at, RememberInput{Type: "Project", Title: "P"}); CodeOf(err) != CodeRefused {
		t.Errorf("project at root: %v", err)
	}
	if _, err := Remember(b, root, "human:guy", at, RememberInput{Type: "Rumor", Title: "P"}); CodeOf(err) != CodeRefused {
		t.Errorf("unknown type: %v", err)
	}
	if _, err := Remember(b, root, "human:guy", at, RememberInput{Title: "P"}); CodeOf(err) != CodeUsage {
		t.Errorf("missing type is usage: %v", err)
	}
	dep, err := DeprecateKey(b, root, "human:guy", at, "author-name")
	if err != nil || dep.Status != "deprecated" || dep.Job.Message != "memory: deprecation Author name" {
		t.Fatalf("%+v %v", dep, err)
	}
	if _, err := DeprecateKey(b, root, "human:guy", at, "author-name"); CodeOf(err) != CodeRefused {
		t.Error("double deprecate")
	}
	if r, err := RestoreKey(b, root, "human:guy", at, "author-name"); err != nil || r.Status != "stable" || r.Job.Message != "memory: update Author name" {
		t.Errorf("%+v %v", r, err)
	}
	if _, err := Show(b, root, "nope"); CodeOf(err) != CodeNotFound {
		t.Error("show missing")
	}
}

func TestSummarize(t *testing.T) {
	b := initBundle(t)
	d, _ := b.Dir("github.com/a/b")
	at := time.Date(2026, 1, 4, 11, 0, 0, 0, time.UTC)
	res, err := Summarize(b, d, "pi/k", at, "pi:session/s", "# Reflections\n\n# Observations\n")
	if err != nil || !res.Created || res.Rel != "projects/github.com/a/b/session-summaries/20260104T110000Z-pi-k.md" {
		t.Fatalf("%+v %v", res, err)
	}
	c, _ := b.ReadConcept(res.Rel)
	if c.Title != "2026-01-04 11:00 UTC pi/k" || c.Description != "Session pi:session/s" || c.Sources[0].Resource != "pi:session/s" {
		t.Errorf("%+v", c)
	}
	res2, err := Summarize(b, d, "pi/k", at.Add(time.Minute), "pi:session/s", "# Reflections\n\n# Observations\n[aaaaaaaaaaaa] 2026-01-04 10:59 [high] x\n")
	if err != nil || res2.Created || res2.Rel != res.Rel {
		t.Fatalf("revise: %+v %v", res2, err)
	}
	if _, err := Summarize(b, d, "pi/k", at.Add(2*time.Minute), "pi:session/s", "new"); CodeOf(err) != CodeRefused {
		t.Error("summarize over folded observations must refuse")
	}
}

func TestCheckFindsProblems(t *testing.T) {
	b := initBundle(t)
	root, _ := b.Dir("")
	res, _ := Remember(b, root, "human:guy", time.Now().UTC(), RememberInput{Type: "User", Title: "Me"})
	res.Job.Run(b)
	r, err := Check(b)
	if err != nil || !r.OK {
		t.Fatalf("%+v %v", r, err)
	}
	b.WriteAtomic("user/me.md", "---\ntitle: no type\n---\n")
	b.WriteAtomic("stray.md", "AKIAIOSFODNN7EXAMPLE\n")
	b.WriteAtomic("feedback/bad.md", "---\ntype: Project\ntitle: wrong place\nstatus: stable\ngenerated:\n  by: human:guy\n  at: 2026-01-01T00:00:00Z\n---\n")
	r, _ = Check(b)
	want := map[string]string{"stray.md": "unrecognized file", "user/me.md": "concept has no type", "feedback/bad.md": "Project is not allowed at the bundle root", "index.md": "index differs from regeneration"}
	seen := map[string]bool{}
	for _, p := range r.Problems {
		if w, ok := want[p.Rel]; ok && strings.Contains(p.Problem, w) {
			seen[p.Rel] = true
		}
		if p.Rel == "stray.md" && strings.Contains(p.Problem, "secret (aws)") {
			seen["secret"] = true
		}
	}
	if r.OK || len(seen) != 5 {
		t.Errorf("problems %+v, matched %v", r.Problems, seen)
	}
}
