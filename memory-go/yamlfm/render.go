package yamlfm

import (
	"strings"
	"unicode"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

const indentStep = "  "

// RenderDocument is renderDocument() in src/frontmatter.mjs: the YAML
// stringified with lineWidth 0, trimmed at the end, fenced, then the body
// with a trailing newline guaranteed unless empty.
func RenderDocument(data *Map, body string) string {
	y := strings.TrimRightFunc(renderNode(data, "", false), isJSWhitespace)
	if body != "" && !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	return "---\n" + y + "\n---\n" + body
}

// isJSWhitespace is String.prototype.trimEnd's whitespace set: Unicode
// White_Space plus the BOM (U+FEFF), same as internal/js.Trim uses.
func isJSWhitespace(r rune) bool {
	return unicode.IsSpace(r) || r == '\uFEFF'
}

func renderNode(v Value, indent string, implicitKey bool) string {
	switch x := v.(type) {
	case *Map:
		return renderMap(x, indent)
	case Seq:
		return renderSeq(x, indent)
	case string:
		return renderString(x, indent, implicitKey)
	case int64:
		return js.Number(float64(x))
	case float64:
		return renderFloat(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case nil:
		return "null"
	}
	panic("yamlfm: unsupported value type")
}

func renderFloat(f float64) string {
	switch {
	case f != f:
		return ".nan"
	case f > 1.7976931348623157e308:
		return ".inf"
	case f < -1.7976931348623157e308:
		return "-.inf"
	}
	return js.Number(f)
}

func isCollection(v Value) bool {
	switch v.(type) {
	case *Map, Seq:
		return true
	}
	return false
}

func isEmptyCollection(v Value) bool {
	switch x := v.(type) {
	case *Map:
		return x.Len() == 0
	case Seq:
		return len(x) == 0
	}
	return false
}

// renderMap is YAMLMap.toString under stringifyBlockCollection: items at this
// indent joined by "\n" + indent; an empty map is the flow form.
//
// yaml@2.9.0's explicit-key "? key" form only fires when a Pair's value node
// is itself absent (YAMLMap.hasAllNullValues(false) in nodes/Collection.js:
// `n == null`, not a Scalar wrapping JS null, since allowScalar is false).
// Every value this renderer sees came from a JS object, so a null field is
// always a Scalar(null), never an absent Pair value: hasAllNullValues is
// always false here and "? key" never renders (verified against real
// yaml@2.9.0: {a: null, b: null} stringifies as "a: null\nb: null").
func renderMap(m *Map, indent string) string {
	if m.Len() == 0 {
		return "{}"
	}
	lines := make([]string, 0, len(m.Pairs))
	for _, p := range m.Pairs {
		lines = append(lines, renderPair(p, indent))
	}
	return strings.Join(lines, "\n"+indent)
}

// renderSeq is YAMLSeq.toString: "- " items whose own indent is two deeper.
func renderSeq(s Seq, indent string) string {
	if len(s) == 0 {
		return "[]"
	}
	itemIndent := indent + "  "
	lines := make([]string, 0, len(s))
	for _, item := range s {
		lines = append(lines, "- "+renderNode(item, itemIndent, false))
	}
	return strings.Join(lines, "\n"+indent)
}

// renderPair is stringifyPair for a block mapping without comments: the key
// rendered as an implicit key at indent+step, a colon, then the value with
// the separator stringifyPair picks.
func renderPair(p Pair, indent string) string {
	inner := indent + indentStep
	key := renderString(p.Key, inner, true)
	str := key + ":"
	val := renderNode(p.Value, inner, false)
	ws := " "
	switch {
	case isCollection(p.Value) && !isEmptyCollection(p.Value):
		ws = "\n" + inner
	case val == "" || val[0] == '\n':
		ws = ""
	}
	return str + ws + val
}
