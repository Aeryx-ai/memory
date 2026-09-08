package memory

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func initBundle(t *testing.T) *Bundle {
	t.Helper()
	b := New(filepath.Join(t.TempDir(), "memory"))
	if err := b.Init("", time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestWithLock(t *testing.T) {
	b := initBundle(t)
	ran, err := WithLock(b.Root, "git", 5*time.Minute, func() error {
		inner, _ := WithLock(b.Root, "git", 5*time.Minute, func() error { return nil })
		if inner {
			t.Error("nested lock must not run")
		}
		return nil
	})
	if !ran || err != nil {
		t.Fatal(ran, err)
	}
	if _, err := os.Stat(filepath.Join(b.Root, ".locks", "git")); err == nil {
		t.Error("lock released")
	}
	lock := filepath.Join(b.Root, ".locks", "git")
	os.MkdirAll(lock, 0o755)
	old := time.Now().Add(-10 * time.Minute)
	os.Chtimes(lock, old, old)
	ran, _ = WithLock(b.Root, "git", 5*time.Minute, func() error { return nil })
	if !ran {
		t.Error("stale lock must be reclaimed")
	}
	if _, err := WithLock(b.Root, "git", 5*time.Minute, func() error { return Errorf(CodeSync, "boom") }); CodeOf(err) != CodeSync {
		t.Error("fn error propagates")
	}
	if _, err := os.Stat(lock); err == nil {
		t.Error("lock released after error")
	}
}

func TestCommitAllAndJob(t *testing.T) {
	b := initBundle(t)
	if ok, err := CommitAll(b.Root, "first"); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, _ := CommitAll(b.Root, "nothing"); ok {
		t.Error("clean tree commits nothing")
	}
	root, _ := b.Dir("")
	b.WriteConcept(b.ConceptRel(root, "User", "me"), mk(t, "User", "Me", "who"))
	ran, err := Job{DirRel: "", Message: "memory: remember Me"}.Run(b)
	if !ran || err != nil {
		t.Fatal(ran, err)
	}
	idx, _ := b.Read("index.md")
	if idx != "---\nokf_version: \"0.2\"\n---\n# User\n\n* [Me](user/me.md) - who\n" {
		t.Errorf("index after job %q", idx)
	}
	out, _, _ := Git(b.Root, []string{"log", "--format=%s", "-1"}, false, 0)
	if out != "memory: remember Me" {
		t.Errorf("commit message %q", out)
	}
	name, _, _ := Git(b.Root, []string{"log", "--format=%an <%ae>", "-1"}, false, 0)
	if name != "memory <memory@localhost>" {
		t.Errorf("author %q", name)
	}
	proj, _ := b.Dir("local/x")
	b.WriteConcept(b.ConceptRel(proj, "Project", "goal"), mk(t, "Project", "Goal", "g"))
	Job{DirRel: "projects/local/x", Message: "m"}.Run(b)
	if pi, _ := b.Read("projects/local/x/index.md"); pi != "# Project\n\n* [Goal](project/goal.md) - g\n" {
		t.Errorf("project index %q", pi)
	}
	if ran, _ := (Job{}).Run(b); ran {
		t.Error("zero job runs nothing")
	}
}

func TestSyncWithRemote(t *testing.T) {
	remote := t.TempDir()
	if _, _, err := Git(remote, []string{"init", "-q", "--bare", "-b", "main"}, false, 0); err != nil {
		t.Fatal(err)
	}
	b := initBundle(t)
	Git(b.Root, []string{"remote", "add", "origin", remote}, false, 0)
	CommitAll(b.Root, "init")
	r, err := SyncGit(b.Root, true, true)
	if err != nil || !r.Pushed || r.Conflict {
		t.Fatalf("%+v %v", r, err)
	}
	r, skipped, err := b.Sync(false, false)
	if err != nil || skipped || r.Conflict {
		t.Fatalf("%+v %v %v", r, skipped, err)
	}
	other := initBundle(t)
	if r, _ := SyncGit(other.Root, true, true); r.Pushed || r.Pulled {
		t.Error("no remote means no sync")
	}
}
