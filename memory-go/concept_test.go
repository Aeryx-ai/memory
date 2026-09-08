package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var at0 = time.Date(2026, 8, 29, 10, 0, 0, 0, time.UTC)

func mk(t *testing.T, typ, title, desc string) *Concept {
	t.Helper()
	c, err := Create(CreateInput{Type: typ, Title: title, Description: desc, Actor: "human:guy", At: at0})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func ptr[T any](v T) *T { return &v }

func TestGoldenConceptsRoundTrip(t *testing.T) {
	n := 0
	err := filepath.WalkDir(filepath.Join(goldenDir, "bundle"), func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".md") {
			return err
		}
		base := filepath.Base(p)
		if base == "index.md" || base == "log.md" {
			return nil
		}
		raw, _ := os.ReadFile(p)
		c, err := ParseConcept(string(raw))
		if err != nil {
			t.Errorf("%s: %v", p, err)
			return nil
		}
		if got := RenderConcept(c); got != string(raw) {
			t.Errorf("%s: render differs\n--- got ---\n%s\n--- want ---\n%s", p, got, raw)
		}
		n++
		return nil
	})
	if err != nil || n == 0 {
		t.Fatalf("walked %d concepts, err %v", n, err)
	}
}

func TestCreateRenders(t *testing.T) {
	c, err := Create(CreateInput{Type: "Feedback", Title: " Reminders via Telegram ", Description: "\"remind me\" means a scheduled job", Tags: []string{"telegram"}, Actor: "claude-code/claude-fable-5", At: time.Date(2026, 8, 28, 20, 15, 0, 0, time.UTC), Sources: []Source{{Resource: "claude-code:session/28c669b5"}}, Body: "Body in markdown."})
	if err != nil {
		t.Fatal(err)
	}
	want := "---\ntype: Feedback\ntitle: Reminders via Telegram\ndescription: '\"remind me\" means a scheduled job'\ntags:\n  - telegram\nstatus: stable\ngenerated:\n  by: claude-code/claude-fable-5\n  at: 2026-08-28T20:15:00.000Z\nsources:\n  - resource: claude-code:session/28c669b5\n---\nBody in markdown.\n"
	if got := RenderConcept(c); got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}

func TestRefusals(t *testing.T) {
	cases := []struct {
		name string
		in   CreateInput
		msg  string
	}{
		{"type", CreateInput{Type: "Rumor", Title: "x", Actor: "human:guy", At: at0}, "not in"},
		{"title", CreateInput{Type: "User", Title: "  ", Actor: "human:guy", At: at0}, "title is empty"},
		{"status", CreateInput{Type: "User", Title: "x", Status: "deprecated", Actor: "human:guy", At: at0}, "cannot start"},
		{"actor", CreateInput{Type: "User", Title: "x", Actor: "bad actor", At: at0}, "malformed actor"},
		{"secret title", CreateInput{Type: "User", Title: "AKIAIOSFODNN7EXAMPLE", Actor: "human:guy", At: at0}, "secret (aws) in title"},
		{"secret body", CreateInput{Type: "User", Title: "x", Body: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij123456", Actor: "human:guy", At: at0}, "secret (github) in body"},
		{"dup source", CreateInput{Type: "User", Title: "x", Actor: "human:guy", At: at0, Sources: []Source{{Resource: "a"}, {Resource: "a"}}}, "duplicate source a"},
		{"dup source id", CreateInput{Type: "User", Title: "x", Actor: "human:guy", At: at0, Sources: []Source{{Resource: "a", ID: "1"}, {Resource: "a", ID: "1"}}}, "duplicate source a (1)"},
		{"empty resource", CreateInput{Type: "User", Title: "x", Actor: "human:guy", At: at0, Sources: []Source{{}}}, "source needs a resource"},
	}
	for _, c := range cases {
		_, err := Create(c.in)
		if CodeOf(err) != CodeRefused || !strings.Contains(err.Error(), c.msg) {
			t.Errorf("%s: got %v, want refused containing %q", c.name, err, c.msg)
		}
	}
	if _, err := Create(CreateInput{Type: "User", Title: "x", Actor: "human:guy", At: at0, Sources: []Source{{Resource: "a", ID: "1"}, {Resource: "a", ID: "2"}}}); err != nil {
		t.Errorf("same resource, different ids must pass: %v", err)
	}
}

func TestTransitions(t *testing.T) {
	c := mk(t, "Feedback", "T", "d")
	later := at0.Add(time.Hour)
	d, err := Deprecate(c, "pi/k", later)
	if err != nil || d.Status != "deprecated" || d.Generated.By != "pi/k" || d.Generated.At != "2026-08-29T11:00:00.000Z" {
		t.Fatalf("deprecate: %+v %v", d, err)
	}
	if _, err := Deprecate(d, "pi/k", later); CodeOf(err) != CodeRefused {
		t.Error("double deprecate must refuse")
	}
	r, err := Restore(d, "pi/k", later)
	if err != nil || r.Status != "stable" {
		t.Fatal(err)
	}
	if _, err := Restore(r, "pi/k", later); CodeOf(err) != CodeRefused {
		t.Error("restore of stable must refuse")
	}
	draft, _ := Create(CreateInput{Type: "Feedback", Title: "D", Status: "draft", Actor: "human:guy", At: at0})
	if _, err := Revise(draft, ReviseFields{Status: ptr("draft")}, "human:guy", later); CodeOf(err) != CodeRefused {
		t.Error("revise to draft must refuse")
	}
	if _, err := Revise(d, ReviseFields{Status: ptr("stable")}, "human:guy", later); CodeOf(err) != CodeRefused {
		t.Error("promote deprecated must refuse")
	}
	if _, err := Revise(draft, ReviseFields{Sources: []Source{{Resource: "s1"}, {Resource: "s1"}}}, "human:guy", later); CodeOf(err) != CodeRefused {
		t.Error("two identical new sources in one revise are refused, as Node's finish() does")
	}
	p, err := Revise(draft, ReviseFields{Status: ptr("stable"), Description: ptr("promoted"), Sources: []Source{{Resource: "s1"}}}, "human:guy", later)
	if err != nil || p.Status != "stable" || p.Description != "promoted" || len(p.Sources) != 1 {
		t.Fatalf("promote: %+v %v", p, err)
	}
	p2, _ := Revise(p, ReviseFields{Sources: []Source{{Resource: "s1"}, {Resource: "s2"}}}, "human:guy", later)
	if len(p2.Sources) != 2 || p2.Status != "stable" {
		t.Errorf("source merge: %+v", p2.Sources)
	}
	if err := ValidateConcept(mk(t, "Project", "P", ""), true); CodeOf(err) != CodeRefused || !strings.Contains(err.Error(), "not allowed at the bundle root") {
		t.Errorf("root project: %v", err)
	}
	if err := ValidateConcept(mk(t, "User", "U", ""), false); err == nil || !strings.Contains(err.Error(), "project directory") {
		t.Errorf("project user: %v", err)
	}
}

func TestParsePreservesExtraAndNormalizes(t *testing.T) {
	text := "---\ntype: Feedback\ntitle: x\nstatus: stable\ngenerated:\n  by: human:guy\n  at: 2026-01-01T00:00:00Z\n  note: kept\nverified:\n  by: pi/k\n  at: 2026-01-02T00:00:00Z\nsources:\n  - resource: r\n    note: kept\ncustom: 1\n---\nb\n"
	c, err := ParseConcept(text)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Verified) != 1 || c.Verified[0].By != "pi/k" {
		t.Errorf("verified normalized to a list: %+v", c.Verified)
	}
	if v, _ := c.Extra.Get("custom"); v != int64(1) {
		t.Errorf("extra: %#v", c.Extra)
	}
	if v, _ := c.Sources[0].Extra.Get("note"); v != "kept" {
		t.Errorf("source extra: %#v", c.Sources[0])
	}
	if c.Generated.Extra == nil {
		t.Fatal("generated extra not set")
	}
	if v, _ := c.Generated.Extra.Get("note"); v != "kept" {
		t.Errorf("generated extra: %#v", c.Generated.Extra)
	}
	want := strings.Replace(text, "verified:\n  by: pi/k\n  at: 2026-01-02T00:00:00Z\n", "verified:\n  - by: pi/k\n    at: 2026-01-02T00:00:00Z\n", 1)
	if got := RenderConcept(c); got != want {
		t.Errorf("round trip\n%s", got)
	}
	if _, err := ParseConcept("---\ntitle: no type\n---\n"); err == nil || !strings.Contains(err.Error(), "concept has no type") {
		t.Error(err)
	}
	if _, err := ParseConcept("---\ntype: User\ntitle: x\ngenerated:\n  by: human:guy\n---\n"); err == nil || !strings.Contains(err.Error(), "generated.at missing") {
		t.Error(err)
	}
}
