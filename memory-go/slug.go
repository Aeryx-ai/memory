package memory

import (
	"regexp"
	"strings"

	"golang.org/x/text/unicode/norm"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

var slugNonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify: NFKD, drop combining marks U+0300 to U+036F, lowercase, collapse
// runs of anything but [a-z0-9] to one dash, trim dashes, cut to 80, trim
// trailing dashes again. Empty is refused.
func Slugify(title string) (string, error) {
	s := norm.NFKD.String(title)
	s = strings.Map(func(r rune) rune {
		if r >= 0x300 && r <= 0x36f {
			return -1
		}
		return r
	}, s)
	s = js.Lower(s)
	s = slugNonAlnum.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 80 {
		s = s[:80]
	}
	s = strings.TrimRight(s, "-")
	if s == "" {
		return "", Errorf(CodeRefused, "title %s yields an empty slug", quoteJSON(title))
	}
	return s, nil
}
