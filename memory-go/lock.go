package memory

import (
	"errors"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"time"
)

// rememberLockSerial is how long a single Remember may take before a lock
// file it left behind (a kill between take and release) is reclaimed.
const rememberLockStale = 2 * time.Minute

const rememberLockPoll = 5 * time.Millisecond

// rememberMu shards the in-process half of the remember lock: goroutines in
// one process serialize on a stripe of the path, and the mkdir lock on disk
// serializes across processes (a second memory-go caller, the Node CLI).
var rememberMu [64]chan struct{}

func init() {
	for i := range rememberMu {
		rememberMu[i] = make(chan struct{}, 1)
	}
}

func rememberStripe(abs string) chan struct{} {
	h := fnv.New64a()
	h.Write([]byte(abs))
	return rememberMu[h.Sum64()%uint64(len(rememberMu))]
}

// withRememberLock runs fn holding both halves of the lock for the concept
// at abs: the goroutine stripe, then <abs>.lock by mkdir, blocking in 5ms
// polls until the directory is free or older than rememberLockStale and
// reclaimed. Remember is read-modify-write, so a concurrent second call on
// one title would read the same base and the later write would silently
// discard the earlier revision; the lock makes the later call read the
// earlier one's result instead.
func withRememberLock(abs string, fn func() error) error {
	stripe := rememberStripe(abs)
	stripe <- struct{}{}
	defer func() { <-stripe }()

	if err := os.MkdirAll(filepath.Dir(abs), 0o777); err != nil {
		return err
	}
	lock := abs + ".lock"
	for {
		if err := os.Mkdir(lock, 0o777); err == nil {
			break
		} else if !errors.Is(err, os.ErrExist) {
			return err
		}
		st, statErr := os.Stat(lock)
		if statErr != nil || time.Since(st.ModTime()) > rememberLockStale {
			aside := fmt.Sprintf("%s.stale-%d-%d", lock, os.Getpid(), time.Now().UnixMilli())
			if err := os.Rename(lock, aside); err == nil {
				os.RemoveAll(aside)
			}
			continue
		}
		time.Sleep(rememberLockPoll)
	}
	defer os.Remove(lock)
	return fn()
}

// rememberLockPath is exported for the lock's own tests.
func rememberLockPath(b *Bundle, rel string) string {
	return filepath.Join(b.Root, filepath.FromSlash(rel)) + ".lock"
}
