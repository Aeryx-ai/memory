package memory

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const lockStale = 5 * time.Minute

// Git runs git in root. A failure returns an *Error with CodeSync unless
// allowFail, in which case ok is false and err nil. A zero timeout waits.
func Git(root string, args []string, allowFail bool, timeout time.Duration) (out string, ok bool, err error) {
	ctx := context.Background()
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = root
	cmd.Stdin = nil
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if allowFail {
			return "", false, nil
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", false, Errorf(CodeSync, "git %s: %s", strings.Join(args, " "), msg)
	}
	return strings.TrimSpace(stdout.String()), true, nil
}

// WithLock takes <root>/.locks/<name> by mkdir, reclaims it when older than
// stale by renaming it aside first, and returns ran=false without waiting
// when it is held. fn's error is returned; the lock is always released.
func WithLock(root, name string, stale time.Duration, fn func() error) (bool, error) {
	lock := filepath.Join(root, ".locks", name)
	if err := os.MkdirAll(filepath.Dir(lock), 0o777); err != nil {
		return false, err
	}
	if err := os.Mkdir(lock, 0o777); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return false, err
		}
		st, statErr := os.Stat(lock)
		isStale := statErr != nil || time.Since(st.ModTime()) > stale
		if !isStale {
			return false, nil
		}
		aside := fmt.Sprintf("%s.stale-%d-%d", lock, os.Getpid(), time.Now().UnixMilli())
		if err := os.Rename(lock, aside); err != nil {
			return false, nil
		}
		os.RemoveAll(aside)
		if err := os.Mkdir(lock, 0o777); err != nil {
			return false, nil
		}
	}
	defer os.RemoveAll(lock)
	return true, fn()
}

// CommitAll stages everything and commits as the memory user; false when
// the tree was clean.
func CommitAll(root, message string) (bool, error) {
	if _, _, err := Git(root, []string{"add", "-A"}, false, 0); err != nil {
		return false, err
	}
	status, _, err := Git(root, []string{"status", "--porcelain"}, false, 0)
	if err != nil {
		return false, err
	}
	if status == "" {
		return false, nil
	}
	_, _, err = Git(root, []string{"-c", "user.name=memory", "-c", "user.email=memory@localhost", "commit", "-q", "-m", message}, false, 0)
	return err == nil, err
}

func HasRemote(root string) bool {
	_, ok, _ := Git(root, []string{"remote", "get-url", "origin"}, true, 0)
	return ok
}

type SyncResult struct {
	Pulled, Pushed, Conflict bool
}

// SyncGit is sync(): pull --rebase then push, each best effort with a 60s
// timeout; a failed pull that left a rebase in progress is aborted and
// reported as a conflict.
func SyncGit(root string, pull, push bool) (SyncResult, error) {
	var r SyncResult
	if !HasRemote(root) {
		return r, nil
	}
	branch, _, err := Git(root, []string{"rev-parse", "--abbrev-ref", "HEAD"}, false, 0)
	if err != nil {
		return r, err
	}
	if pull {
		_, ok, _ := Git(root, []string{"pull", "--rebase", "-q", "origin", branch}, true, 60*time.Second)
		if !ok {
			_, mergeErr := os.Stat(filepath.Join(root, ".git", "rebase-merge"))
			_, applyErr := os.Stat(filepath.Join(root, ".git", "rebase-apply"))
			if mergeErr == nil || applyErr == nil {
				Git(root, []string{"rebase", "--abort"}, true, 0)
				r.Conflict = true
				return r, nil
			}
		} else {
			r.Pulled = true
		}
	}
	if push {
		_, ok, _ := Git(root, []string{"push", "-q", "-u", "origin", branch}, true, 60*time.Second)
		r.Pushed = ok
	}
	return r, nil
}

// Sync is the CLI's sync handler: commit pending, pull and push as asked,
// regenerate every index when the pull changed something and push that too.
// skipped is true when the git lock was held.
func (b *Bundle) Sync(pull, push bool) (SyncResult, bool, error) {
	if err := requireBundle(b); err != nil {
		return SyncResult{}, false, err
	}
	both := !pull && !push
	var r SyncResult
	ran, err := WithLock(b.Root, "git", lockStale, func() error {
		if _, err := CommitAll(b.Root, "memory: sync"); err != nil {
			return err
		}
		var err error
		r, err = SyncGit(b.Root, both || pull, both || push)
		if err != nil {
			return err
		}
		if r.Pulled {
			dirs, err := b.Dirs()
			if err != nil {
				return err
			}
			for _, d := range dirs {
				if err := b.WriteIndex(d); err != nil {
					return err
				}
			}
			committed, err := CommitAll(b.Root, "memory: regenerate index after pull")
			if err != nil {
				return err
			}
			if committed {
				second, err := SyncGit(b.Root, false, both || push)
				if err != nil {
					return err
				}
				r.Pushed = second.Pushed
				r.Conflict = r.Conflict || second.Conflict
			}
		}
		return nil
	})
	if err != nil {
		return r, false, err
	}
	if !ran {
		return r, true, nil
	}
	if r.Conflict {
		return r, false, Errorf(CodeSync, "rebase conflict; resolve in the bundle by hand")
	}
	return r, false, nil
}
