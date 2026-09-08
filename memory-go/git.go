// memory-go/git.go (temporary, Task 9 replaces it)
package memory

import (
	"os/exec"
	"strings"
	"time"
)

func Git(root string, args []string, allowFail bool, timeout time.Duration) (string, bool, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		if allowFail {
			return "", false, nil
		}
		return "", false, Errorf(CodeSync, "git %s: %v", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(out)), true, nil
}

func HasRemote(root string) bool {
	_, ok, _ := Git(root, []string{"remote", "get-url", "origin"}, true, 0)
	return ok
}
