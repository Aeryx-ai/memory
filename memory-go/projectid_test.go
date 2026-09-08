package memory

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestProjectIDGolden(t *testing.T) {
	cases := loadCases(t)
	for _, c := range cases.ProjectID {
		got, err := ProjectIDFromOrigin(str(t, c.Input))
		if c.Error != "" {
			if CodeOf(err) != Code(c.Error) {
				t.Errorf("ProjectIDFromOrigin(%s): got %q, %v; want %s", c.Input, got, err, c.Error)
			}
			if err == nil || err.Error() != c.Message {
				t.Errorf("ProjectIDFromOrigin(%s) message = %v; want %q", c.Input, err, c.Message)
			}
			continue
		}
		if err != nil || got != str(t, c.OK) {
			t.Errorf("ProjectIDFromOrigin(%s) = %q, %v; want %s", c.Input, got, err, c.OK)
		}
	}
	for _, c := range cases.AssertProjectID {
		got, err := AssertProjectID(str(t, c.Input))
		if c.Error != "" {
			if CodeOf(err) != Code(c.Error) {
				t.Errorf("AssertProjectID(%s): got %q, %v; want %s", c.Input, got, err, c.Error)
			}
			if err == nil || err.Error() != c.Message {
				t.Errorf("AssertProjectID(%s) message = %v; want %q", c.Input, err, c.Message)
			}
			continue
		}
		if err != nil || got != str(t, c.OK) {
			t.Errorf("AssertProjectID(%s) = %q, %v; want %s", c.Input, got, err, c.OK)
		}
	}
}

func gitRepo(t *testing.T, origin string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	if origin != "" {
		run("remote", "add", "origin", origin)
	}
	return dir
}

func TestProjectIDFor(t *testing.T) {
	repo := gitRepo(t, "git@github.com:guygrigsby/x.git")
	sub := filepath.Join(repo, "a", "b")
	os.MkdirAll(sub, 0o755)
	if id, err := ProjectIDFor(sub); err != nil || id != "github.com/guygrigsby/x" {
		t.Errorf("subdir of repo: %q %v", id, err)
	}
	noRemote := gitRepo(t, "")
	if id, _ := ProjectIDFor(noRemote); id != "local/"+filepath.Base(noRemote) {
		t.Errorf("no remote: %q", id)
	}
	bad := gitRepo(t, "/local/path")
	if id, _ := ProjectIDFor(bad); id != "local/"+filepath.Base(bad) {
		t.Errorf("unparseable origin falls back to local: %q", id)
	}
	plain := t.TempDir()
	if id, _ := ProjectIDFor(plain); id != "local/"+filepath.Base(plain) {
		t.Errorf("outside git: %q", id)
	}
}
