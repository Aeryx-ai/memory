package memory

import "strings"

// Job is the write-completion work Node runs in a detached process after a
// concept write: regenerate the directory's index, commit everything and
// push. A zero Job runs nothing. The caller decides whether to run it in a
// goroutine; the SDK never starts one.
type Job struct {
	DirRel  string
	Message string
}

// Run executes the job under the git lock. ran is false when the lock was
// held (the next write's job commits everything pending) or the job is zero.
func (j Job) Run(b *Bundle) (bool, error) {
	if j.Message == "" {
		return false, nil
	}
	return WithLock(b.Root, "git", lockStale, func() error {
		dir, err := b.Dir(strings.TrimPrefix(j.DirRel, "projects/"))
		if err != nil {
			return err
		}
		if err := b.WriteIndex(dir); err != nil {
			return err
		}
		if _, err := CommitAll(b.Root, j.Message); err != nil {
			return err
		}
		_, err = SyncGit(b.Root, false, true)
		return err
	})
}
