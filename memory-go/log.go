package memory

import (
	"regexp"
	"strings"
	"time"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

type LogKind string

const (
	LogCreation       LogKind = "Creation"
	LogUpdate         LogKind = "Update"
	LogDeprecation    LogKind = "Deprecation"
	LogInitialization LogKind = "Initialization"
)

const logHeader = "# Directory Update Log\n"

var logHeading = regexp.MustCompile(`(?m)^## (\d{4}-\d{2}-\d{2})\n`)

type logBlock struct {
	date  string
	lines []string
}

// AppendLog is appendLog(): the line lands under today's "## date" heading,
// which is created in date-descending position when absent.
func (b *Bundle) AppendLog(dir Dir, kind LogKind, c *Concept, rel, actor string, at time.Time) error {
	logRel := joinRel(dir.Rel, "log.md")
	day := js.ISO(at)[:10]
	line := "* **" + string(kind) + "**: [" + c.Title + "](" + relTo(dir.Rel, rel) + ") by " + actor
	text, ok := b.Read(logRel)
	if !ok {
		text = logHeader
	}
	blocks := parseLogBlocks(text)
	placed := false
	for i := range blocks {
		if blocks[i].date == day {
			blocks[i].lines = append(blocks[i].lines, line)
			placed = true
			break
		}
	}
	if !placed {
		at := len(blocks)
		for i, blk := range blocks {
			if blk.date < day {
				at = i
				break
			}
		}
		blocks = append(blocks[:at], append([]logBlock{{date: day, lines: []string{line}}}, blocks[at:]...)...)
	}
	return b.WriteAtomic(logRel, renderLog(blocks))
}

func parseLogBlocks(text string) []logBlock {
	matches := logHeading.FindAllStringSubmatchIndex(text, -1)
	blocks := make([]logBlock, 0, len(matches))
	for i, m := range matches {
		start := m[1]
		end := len(text)
		if i+1 < len(matches) {
			end = matches[i+1][0]
		}
		var lines []string
		for _, l := range strings.Split(text[start:end], "\n") {
			if l != "" {
				lines = append(lines, l)
			}
		}
		blocks = append(blocks, logBlock{date: text[m[2]:m[3]], lines: lines})
	}
	return blocks
}

func renderLog(blocks []logBlock) string {
	parts := make([]string, 0, len(blocks))
	for _, blk := range blocks {
		parts = append(parts, "## "+blk.date+"\n"+strings.Join(blk.lines, "\n")+"\n")
	}
	return logHeader + "\n" + strings.Join(parts, "\n")
}
