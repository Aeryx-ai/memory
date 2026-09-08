package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func goldenBundle(t *testing.T) *Bundle {
	t.Helper()
	abs, _ := filepath.Abs(filepath.Join(goldenDir, "bundle"))
	return New(abs)
}

func TestDirsAndIndexMatchGolden(t *testing.T) {
	b := goldenBundle(t)
	dirs, err := b.Dirs()
	if err != nil {
		t.Fatal(err)
	}
	var rels []string
	for _, d := range dirs {
		rels = append(rels, d.Rel)
	}
	want := []string{"", "projects/github.com/golden/alpha", "projects/github.com/golden/beta/nested"}
	if strings.Join(rels, ",") != strings.Join(want, ",") {
		t.Fatalf("dirs = %v, want %v", rels, want)
	}
	for _, d := range dirs {
		entries, err := b.ListConcepts(d)
		if err != nil {
			t.Fatal(err)
		}
		got := RenderIndex(entries, d.Rel, d.IsRoot)
		file, _ := b.Read(filepath.ToSlash(filepath.Join(d.Rel, "index.md")))
		if got != file {
			t.Errorf("%q index differs\n--- got ---\n%s\n--- want ---\n%s", d.Rel, got, file)
		}
	}
}

func TestListConceptsOrderAndFind(t *testing.T) {
	b := goldenBundle(t)
	root, _ := b.Dir("")
	entries, _ := b.ListConcepts(root)
	for i := 1; i < len(entries); i++ {
		if CompareFold(entries[i-1].Rel, entries[i].Rel) > 0 {
			t.Errorf("unsorted: %s before %s", entries[i-1].Rel, entries[i].Rel)
		}
	}
	if e, err := b.FindConcept(root, "author-name"); err != nil || e.Rel != "user/author-name.md" {
		t.Errorf("bare key: %+v %v", e, err)
	}
	if e, err := b.FindConcept(root, "user/author-name.md"); err != nil || e.Concept.Title != "Author name" {
		t.Errorf("relative rel: %+v %v", e, err)
	}
	if _, err := b.FindConcept(root, "nope"); CodeOf(err) != CodeNotFound {
		t.Errorf("missing: %v", err)
	}
	alpha, _ := b.Dir("github.com/golden/alpha")
	if e, err := b.FindConcept(alpha, "projects/github.com/golden/alpha/project/use-pnpm.md"); err != nil || e.Concept.Status != "deprecated" {
		t.Errorf("full rel: %+v %v", e, err)
	}
}

func TestDirValidation(t *testing.T) {
	b := New(t.TempDir())
	if _, err := b.Dir("a/../b"); CodeOf(err) != CodeRefused {
		t.Error("bad project id must refuse")
	}
	d, _ := b.Dir("github.com/x/y")
	if d.Rel != "projects/github.com/x/y" || d.IsRoot || d.ProjectID != "github.com/x/y" || d.Abs != filepath.Join(b.Root, "projects", "github.com", "x", "y") {
		t.Errorf("%+v", d)
	}
	if b.ConceptRel(d, "Session Summary", "s") != "projects/github.com/x/y/session-summaries/s.md" {
		t.Error("ConceptRel")
	}
}

func TestInitWritesRootFiles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "memory")
	b := New(root)
	if b.Exists() {
		t.Fatal("fresh root must not exist")
	}
	at := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := b.Init("", at); err != nil {
		t.Fatal(err)
	}
	idx, _ := b.Read("index.md")
	if idx != "---\nokf_version: \"0.2\"\n---\n" {
		t.Errorf("index %q", idx)
	}
	log, _ := b.Read("log.md")
	if log != "# Directory Update Log\n\n## 2020-01-01\n* **Initialization**: Created the memory bundle.\n" {
		t.Errorf("log %q", log)
	}
	gi, _ := b.Read(".gitignore")
	if gi != ".state/\n.locks/\n*.tmp\n" {
		t.Errorf("gitignore %q", gi)
	}
	if _, err := os.Stat(filepath.Join(root, ".git")); err != nil {
		t.Error("git init")
	}
	if err := b.Init("git@github.com:x/y.git", at.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if log2, _ := b.Read("log.md"); log2 != log {
		t.Error("second init must not rewrite the log")
	}
	if !HasRemote(root) {
		t.Error("remote added on second init")
	}
	os.WriteFile(filepath.Join(root, ".gitignore"), []byte(".state/"), 0o644)
	b.EnsureGitignore()
	if gi, _ := b.Read(".gitignore"); gi != ".state/\n*.tmp\n" {
		t.Errorf("gitignore append %q", gi)
	}
}

func TestAppendLog(t *testing.T) {
	root := filepath.Join(t.TempDir(), "memory")
	b := New(root)
	b.Init("", time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC))
	rootDir, _ := b.Dir("")
	c := mk(t, "User", "Author name", "d")
	b.AppendLog(rootDir, "Creation", c, "user/author-name.md", "human:guy", time.Date(2026, 1, 3, 1, 0, 0, 0, time.UTC))
	b.AppendLog(rootDir, "Update", c, "user/author-name.md", "pi/k", time.Date(2026, 1, 3, 2, 0, 0, 0, time.UTC))
	b.AppendLog(rootDir, "Deprecation", c, "user/author-name.md", "pi/k", time.Date(2025, 12, 31, 2, 0, 0, 0, time.UTC))
	got, _ := b.Read("log.md")
	want := "# Directory Update Log\n\n## 2026-01-03\n* **Creation**: [Author name](user/author-name.md) by human:guy\n* **Update**: [Author name](user/author-name.md) by pi/k\n\n## 2026-01-02\n* **Initialization**: Created the memory bundle.\n\n## 2025-12-31\n* **Deprecation**: [Author name](user/author-name.md) by pi/k\n"
	if got != want {
		t.Errorf("log\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
	proj, _ := b.Dir("local/x")
	b.AppendLog(proj, "Creation", c, "projects/local/x/project/goal.md", "human:guy", time.Date(2026, 1, 3, 1, 0, 0, 0, time.UTC))
	got, _ = b.Read("projects/local/x/log.md")
	if got != "# Directory Update Log\n\n## 2026-01-03\n* **Creation**: [Author name](project/goal.md) by human:guy\n" {
		t.Errorf("project log %q", got)
	}
}

func TestWriteAtomicAndStatePath(t *testing.T) {
	b := New(t.TempDir())
	if err := b.WriteAtomic("a/b/c.md", "x"); err != nil {
		t.Fatal(err)
	}
	if got, ok := b.Read("a/b/c.md"); !ok || got != "x" {
		t.Error("read back")
	}
	if _, ok := b.Read("missing"); ok {
		t.Error("missing must be !ok")
	}
	entries, _ := os.ReadDir(filepath.Join(b.Root, "a", "b"))
	if len(entries) != 1 {
		t.Error("temp file left behind")
	}
	p, err := b.StatePath("s.json")
	if err != nil || p != filepath.Join(b.Root, ".state", "s.json") {
		t.Error(p, err)
	}
	if _, err := os.Stat(filepath.Join(b.Root, ".state")); err != nil {
		t.Error(".state created")
	}
}

func TestResolveRoot(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if got := ResolveRoot("/explicit", env(map[string]string{"MEMORY_DIR": "/env"})); got != "/explicit" {
		t.Error(got)
	}
	if got := ResolveRoot("", env(map[string]string{"MEMORY_DIR": "/env"})); got != "/env" {
		t.Error(got)
	}
	if got := ResolveRoot("", env(map[string]string{"HOME": "/home/u"})); got != "/home/u/.agents/memory" {
		t.Error(got)
	}
}
