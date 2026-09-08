package memory

import (
	"regexp"
	"strings"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

type SecretHit struct {
	Name  string `json:"name"`
	Index int    `json:"index"`
}

type secretPattern struct {
	name string
	re   *regexp.Regexp
	// needsDigit replaces the lookahead Node uses on the assignment pattern:
	// the captured value must contain a digit or the candidate is skipped.
	needsDigit bool
}

var secretPatterns = []secretPattern{
	{"aws", regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`), false},
	{"github", regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{36,}\b`), false},
	{"anthropic", regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{32,}\b`), false},
	{"openai", regexp.MustCompile(`\bsk-[A-Za-z0-9]{40,}\b`), false},
	{"telegram", regexp.MustCompile(`\b\d{8,10}:AA[A-Za-z0-9_-]{32,}\b`), false},
	{"pem", regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`), false},
	{"jwt", regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`), false},
	{"bearer", regexp.MustCompile(`\bBearer\s+[A-Za-z0-9._-]{20,}`), false},
	{"assignment", regexp.MustCompile(`(?i)\b(password|passwd|secret|api[_-]?key|token)\s*[=:]\s*["']?([A-Za-z0-9_\-./+=]{12,})`), true},
}

// FindSecret returns the first pattern that matches, in pattern order, with
// the match position in UTF-16 units as Node reports it. Nil means clean.
func FindSecret(text string) *SecretHit {
	for _, p := range secretPatterns {
		for _, m := range p.re.FindAllStringSubmatchIndex(text, -1) {
			if p.needsDigit && !strings.ContainsAny(text[m[4]:m[5]], "0123456789") {
				continue
			}
			return &SecretHit{Name: p.name, Index: js.Len16(text[:m[0]])}
		}
	}
	return nil
}
