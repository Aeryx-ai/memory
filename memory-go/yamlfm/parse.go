package yamlfm

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

// fence is /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/ from src/frontmatter.mjs.
var fence = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---\r?\n?`)

// ParseDocument splits a concept file into frontmatter and body. Without a
// fence the whole text is the body. Scalars resolve by the YAML core schema
// the way yaml@2.9.0's {schema: "core"} does: quoted and block scalars are
// strings, plain scalars are null, bool, int or float when they look like
// one and strings otherwise. Timestamps stay strings.
func ParseDocument(text string) (*Map, string, error) {
	m := fence.FindStringSubmatchIndex(text)
	if m == nil {
		return &Map{}, text, nil
	}
	front, body := text[m[2]:m[3]], text[m[1]:]
	// The fence regex's non-greedy capture never includes the newline that
	// separates the frontmatter content from the closing "---" (that byte is
	// consumed matching "\r?\n---"), same as Node's identical FENCE regex in
	// src/frontmatter.mjs. When the frontmatter's last field is a literal or
	// folded block scalar, that missing newline is exactly the one clip (and
	// keep) chomping is supposed to restore: eemeli/yaml's parser still adds
	// it back even though the raw text it receives lacks a trailing "\n",
	// but go.yaml.in/yaml/v3 does not. Restoring the byte the regex ate
	// before parsing keeps both parsers looking at the same effective
	// document and matches Node's parsed output byte for byte.
	if !strings.HasSuffix(front, "\n") {
		front += "\n"
	}
	var node yaml.Node
	if err := yaml.Unmarshal([]byte(front), &node); err != nil {
		return nil, "", fmt.Errorf("frontmatter: %w", err)
	}
	v, err := fromNode(&node)
	if err != nil {
		return nil, "", err
	}
	data, ok := v.(*Map)
	if !ok {
		data = &Map{}
	}
	return data, body, nil
}

func fromNode(n *yaml.Node) (Value, error) {
	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil, nil
		}
		return fromNode(n.Content[0])
	case yaml.MappingNode:
		m := &Map{}
		seen := map[string]bool{}
		for i := 0; i+1 < len(n.Content); i += 2 {
			k := n.Content[i]
			if k.Kind != yaml.ScalarNode {
				return nil, fmt.Errorf("frontmatter: non-scalar key at line %d", k.Line)
			}
			// yaml@2.9.0 parses with its uniqueKeys: true default, which
			// throws DUPLICATE_KEY rather than letting a later key silently
			// overwrite an earlier one.
			if seen[k.Value] {
				return nil, fmt.Errorf("frontmatter: duplicate key %q at line %d", k.Value, k.Line)
			}
			seen[k.Value] = true
			v, err := fromNode(n.Content[i+1])
			if err != nil {
				return nil, err
			}
			m.Pairs = append(m.Pairs, Pair{k.Value, v})
		}
		return m, nil
	case yaml.SequenceNode:
		s := make(Seq, 0, len(n.Content))
		for _, c := range n.Content {
			v, err := fromNode(c)
			if err != nil {
				return nil, err
			}
			s = append(s, v)
		}
		return s, nil
	case yaml.AliasNode:
		return fromNode(n.Alias)
	case yaml.ScalarNode:
		return scalar(n), nil
	case 0:
		return nil, nil
	}
	return nil, fmt.Errorf("frontmatter: unsupported node kind %d", n.Kind)
}

var quotedStyles = yaml.DoubleQuotedStyle | yaml.SingleQuotedStyle | yaml.LiteralStyle | yaml.FoldedStyle

// scalar resolves one scalar by the core schema. yaml.v3 leaves Value as the
// source text for plain scalars, which is what the tag tests need.
func scalar(n *yaml.Node) Value {
	if n.Style&quotedStyles != 0 {
		return n.Value
	}
	s := n.Value
	switch {
	case coreTagTests[0].MatchString(s):
		return nil
	case coreTagTests[1].MatchString(s):
		return s[0] == 't' || s[0] == 'T'
	case coreTagTests[2].MatchString(s):
		return parseIntOrFloat(s[2:], 8)
	case coreTagTests[3].MatchString(s):
		return parseIntOrFloat(s, 10)
	case coreTagTests[4].MatchString(s):
		return parseIntOrFloat(s[2:], 16)
	case coreTagTests[5].MatchString(s):
		f, _ := strconv.ParseFloat(strings.NewReplacer(".inf", "Inf", ".Inf", "Inf", ".INF", "Inf", ".nan", "NaN", ".NaN", "NaN", ".NAN", "NaN").Replace(s), 64)
		return f
	case coreTagTests[6].MatchString(s), coreTagTests[7].MatchString(s):
		f, _ := strconv.ParseFloat(s, 64)
		return f
	}
	return s
}

// parseIntOrFloat is parseInt: an int64 when it fits, else the double.
func parseIntOrFloat(s string, base int) Value {
	if i, err := strconv.ParseInt(s, base, 64); err == nil {
		return i
	}
	f, _ := strconv.ParseFloat(s, 64)
	return f
}
