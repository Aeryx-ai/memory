package yamlfm

import (
	"regexp"
	"strings"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

// The regular expressions from stringifyString.js and the core schema tags,
// verbatim. Go's RE2 has no lookbehind, so blockEndNewlines is a loop below.
// The JavaScript control class also names lone surrogates, which cannot
// occur in a Go string.
var (
	controlChars   = regexp.MustCompile(`[\x00-\x08\x0b-\x1f\x7f-\x9f]`)
	plainForbidden = regexp.MustCompile("^[\n\t ,\\[\\]{}#&*!|>'\"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$")
	docMarker      = regexp.MustCompile(`(?m)^(%|---|\.\.\.)`)
	wsAroundNl     = regexp.MustCompile("[ \t]\n|\n[ \t]")
	blockEndWs     = regexp.MustCompile("\n[\t ]+$")
	newlineRuns    = regexp.MustCompile("\n+")
	coreTagTests   = []*regexp.Regexp{
		regexp.MustCompile(`^(?:~|[Nn]ull|NULL)?$`),
		regexp.MustCompile(`^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$`),
		regexp.MustCompile(`^0o[0-7]+$`),
		regexp.MustCompile(`^[-+]?[0-9]+$`),
		regexp.MustCompile(`^0x[0-9a-fA-F]+$`),
		regexp.MustCompile(`^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$`),
		regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$`),
		regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$`),
	}
)

func looksTyped(s string) bool {
	for _, re := range coreTagTests {
		if re.MatchString(s) {
			return true
		}
	}
	return false
}

// renderString is stringifyString for a Scalar with no explicit type:
// control characters force double quotes, otherwise the PLAIN path decides.
func renderString(value, indent string, implicitKey bool) string {
	if controlChars.MatchString(value) {
		return doubleQuoted(value, indent, implicitKey)
	}
	return plainString(value, indent, implicitKey)
}

func plainString(value, indent string, implicitKey bool) string {
	hasNl := strings.Contains(value, "\n")
	if implicitKey && hasNl {
		return quoted(value, indent, implicitKey)
	}
	if plainForbidden.MatchString(value) {
		if implicitKey || !hasNl {
			return quoted(value, indent, implicitKey)
		}
		return blockString(value, indent)
	}
	if !implicitKey && hasNl {
		return blockString(value, indent)
	}
	if docMarker.MatchString(value) && implicitKey && indent == indentStep {
		return quoted(value, indent, implicitKey)
	}
	if looksTyped(value) {
		return quoted(value, indent, implicitKey)
	}
	return value
}

func quoted(value, indent string, implicitKey bool) string {
	hasDouble := strings.Contains(value, `"`)
	hasSingle := strings.Contains(value, "'")
	if hasDouble && !hasSingle {
		return singleQuoted(value, indent, implicitKey)
	}
	return doubleQuoted(value, indent, implicitKey)
}

func singleQuoted(value, indent string, implicitKey bool) string {
	if (implicitKey && strings.Contains(value, "\n")) || wsAroundNl.MatchString(value) {
		return doubleQuoted(value, indent, implicitKey)
	}
	if indent == "" && docMarker.MatchString(value) {
		indent = "  "
	}
	s := strings.ReplaceAll(value, "'", "''")
	s = newlineRuns.ReplaceAllString(s, "$0\n"+indent)
	return "'" + s + "'"
}

// doubleQuoted is doubleQuotedString: JSON.stringify, then yaml's own escape
// spelling, then real line breaks for \n once the string is 40 units long.
func doubleQuoted(value, indent string, implicitKey bool) string {
	j := js.JSONQuote(value)
	if indent == "" && docMarker.MatchString(value) {
		indent = "  "
	}
	short := js.Len16(j) < 40
	var b strings.Builder
	start := 0
	at := func(i int) byte {
		if i < len(j) {
			return j[i]
		}
		return 0
	}
	for i := 0; i < len(j); i++ {
		ch := j[i]
		if ch == ' ' && at(i+1) == '\\' && at(i+2) == 'n' {
			b.WriteString(j[start:i])
			b.WriteString(`\ `)
			i++
			start = i
			ch = '\\'
		}
		if ch != '\\' {
			continue
		}
		switch at(i + 1) {
		case 'u':
			b.WriteString(j[start:i])
			code := j[i+2 : i+6]
			switch code {
			case "0000":
				b.WriteString(`\0`)
			case "0007":
				b.WriteString(`\a`)
			case "000b":
				b.WriteString(`\v`)
			case "001b":
				b.WriteString(`\e`)
			case "0085":
				b.WriteString(`\N`)
			case "00a0":
				b.WriteString(`\_`)
			case "2028":
				b.WriteString(`\L`)
			case "2029":
				b.WriteString(`\P`)
			default:
				if code[:2] == "00" {
					b.WriteString(`\x` + code[2:])
				} else {
					b.WriteString(j[i : i+6])
				}
			}
			i += 5
			start = i + 1
		case 'n':
			if implicitKey || at(i+2) == '"' || short {
				i++
			} else {
				b.WriteString(j[start:i])
				b.WriteString("\n\n")
				for at(i+2) == '\\' && at(i+3) == 'n' && at(i+4) != '"' {
					b.WriteString("\n")
					i += 2
				}
				b.WriteString(indent)
				if at(i+2) == ' ' {
					b.WriteString(`\`)
				}
				i++
				start = i + 1
			}
		default:
			i++
		}
	}
	if start == 0 {
		return j
	}
	b.WriteString(j[start:])
	return b.String()
}

// blockString is blockString() with blockQuote true and lineWidth 0, which
// makes every block literal ("|"), never folded (">").
func blockString(value, indent string) string {
	if blockEndWs.MatchString(value) {
		return quoted(value, indent, false)
	}
	if indent == "" && docMarker.MatchString(value) {
		indent = "  "
	}
	endStart := len(value)
	for endStart > 0 {
		c := value[endStart-1]
		if c != '\n' && c != '\t' && c != ' ' {
			break
		}
		endStart--
	}
	end := value[endStart:]
	endNl := strings.Index(end, "\n")
	var chomp string
	switch {
	case endNl == -1:
		chomp = "-"
	case value == end || endNl != len(end)-1:
		chomp = "+"
	default:
		chomp = ""
	}
	if end != "" {
		value = value[:len(value)-len(end)]
		if strings.HasSuffix(end, "\n") {
			end = end[:len(end)-1]
		}
		end = indentNewlineRunsNotAtEnd(end, indent)
	}
	startWithSpace := false
	startEnd := 0
	startNl := -1
	for startEnd < len(value) {
		c := value[startEnd]
		if c == ' ' {
			startWithSpace = true
		} else if c == '\n' {
			startNl = startEnd
		} else {
			break
		}
		startEnd++
	}
	start := value[:startNl+1]
	if start != "" {
		value = value[len(start):]
		start = newlineRuns.ReplaceAllString(start, "$0"+indent)
	}
	indentSize := "1"
	if indent != "" {
		indentSize = "2"
	}
	header := chomp
	if startWithSpace {
		header = indentSize + chomp
	}
	value = newlineRuns.ReplaceAllString(value, "$0"+indent)
	return "|" + header + "\n" + indent + start + value + end
}

// indentNewlineRunsNotAtEnd is /(^|(?<!\n))\n+(?!\n|$)/g replaced by
// "$&indent": every maximal run of newlines that is not at the end of the
// string gets the indent appended.
func indentNewlineRunsNotAtEnd(s, indent string) string {
	var b strings.Builder
	last := 0
	for _, m := range newlineRuns.FindAllStringIndex(s, -1) {
		b.WriteString(s[last:m[1]])
		if m[1] < len(s) {
			b.WriteString(indent)
		}
		last = m[1]
	}
	b.WriteString(s[last:])
	return b.String()
}
