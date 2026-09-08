package memory

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	originScheme = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
	originCred   = regexp.MustCompile(`^[^@/]+@`)
	originScp    = regexp.MustCompile(`^([^@\s]+@)?([^:/\s]+):(.+)$`)
	originPort   = regexp.MustCompile(`:\d+$`)
	originTrail  = regexp.MustCompile(`/+$`)
	originDotGit = regexp.MustCompile(`\.git$`)
	originIsPath = regexp.MustCompile(`(?i)^[a-z]:`)
	projectIDWs  = regexp.MustCompile(`\s`)
)

// AssertProjectID refuses an empty id, whitespace, a leading slash and any
// empty, "." or ".." segment.
func AssertProjectID(id string) (string, error) {
	bad := id == "" || projectIDWs.MatchString(id) || strings.HasPrefix(id, "/")
	if !bad {
		for _, p := range strings.Split(id, "/") {
			if p == "" || p == "." || p == ".." {
				bad = true
				break
			}
		}
	}
	if bad {
		q, _ := json.Marshal(id)
		return "", Errorf(CodeRefused, "malformed project id %s", q)
	}
	return id, nil
}

func malformedOrigin(u string) error {
	q, _ := json.Marshal(u)
	return Errorf(CodeRefused, "malformed project id origin %s", q)
}

// ProjectIDFromOrigin turns a git origin into host/owner/repo: scheme,
// credentials, port and .git stripped, host lowercased, scp form accepted,
// filesystem paths refused.
func ProjectIDFromOrigin(url string) (string, error) {
	u := strings.TrimSpace(url)
	if strings.HasPrefix(u, "/") || strings.HasPrefix(u, ".") || strings.HasPrefix(u, "~") || originIsPath.MatchString(u) {
		return "", malformedOrigin(u)
	}
	var host, p string
	if originScheme.MatchString(u) {
		u = originScheme.ReplaceAllString(u, "")
		u = originCred.ReplaceAllString(u, "")
		i := strings.Index(u, "/")
		if i == -1 {
			return "", malformedOrigin(strings.TrimSpace(url))
		}
		host, p = u[:i], u[i+1:]
	} else {
		m := originScp.FindStringSubmatch(u)
		if m == nil {
			return "", malformedOrigin(strings.TrimSpace(url))
		}
		host, p = m[2], m[3]
	}
	host = originPort.ReplaceAllString(strings.ToLower(host), "")
	p = originDotGit.ReplaceAllString(originTrail.ReplaceAllString(p, ""), "")
	return AssertProjectID(host + "/" + p)
}

func gitQuiet(cwd string, args ...string) (string, bool) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

func LocalProjectID(cwd string) (string, error) {
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return "", err
	}
	return AssertProjectID("local/" + filepath.Base(abs))
}

// ProjectIDFor is projectIdFor(cwd): the origin of the enclosing repo, else
// local/<top level basename>, else local/<cwd basename>.
func ProjectIDFor(cwd string) (string, error) {
	top, ok := gitQuiet(cwd, "rev-parse", "--show-toplevel")
	if !ok {
		return LocalProjectID(cwd)
	}
	origin, ok := gitQuiet(top, "remote", "get-url", "origin")
	if !ok {
		return LocalProjectID(top)
	}
	id, err := ProjectIDFromOrigin(origin)
	if err != nil {
		if CodeOf(err) == CodeRefused {
			return LocalProjectID(top)
		}
		return "", err
	}
	return id, nil
}
