package memory

import (
	"slices"
	"strings"
)

// RenderIndex is renderIndex(): one "# Type" section per type present, in
// vocabulary order, live concepts only, titles sorted with CompareFold and
// Session Summaries newest first; the root carries the okf_version fence.
func RenderIndex(entries []Entry, dirRel string, isRoot bool) string {
	var sections []string
	for _, typ := range Types {
		var items []Entry
		for _, e := range entries {
			if e.Concept.Status != "deprecated" && e.Concept.Type == typ {
				items = append(items, e)
			}
		}
		if len(items) == 0 {
			continue
		}
		if typ == "Session Summary" {
			slices.SortStableFunc(items, func(a, b Entry) int { return CompareFold(b.Concept.Generated.At, a.Concept.Generated.At) })
		} else {
			slices.SortStableFunc(items, func(a, b Entry) int { return CompareFold(a.Concept.Title, b.Concept.Title) })
		}
		lines := make([]string, 0, len(items))
		for _, e := range items {
			lines = append(lines, "* ["+e.Concept.Title+"]("+relTo(dirRel, e.Rel)+") - "+e.Concept.Description)
		}
		sections = append(sections, "# "+typ+"\n\n"+strings.Join(lines, "\n")+"\n")
	}
	out := strings.Join(sections, "\n")
	if isRoot {
		return rootIndex + out
	}
	return out
}

func (b *Bundle) WriteIndex(dir Dir) error {
	entries, err := b.ListConcepts(dir)
	if err != nil {
		return err
	}
	return b.WriteAtomic(joinRel(dir.Rel, "index.md"), RenderIndex(entries, dir.Rel, dir.IsRoot))
}

func joinRel(dirRel, name string) string {
	if dirRel == "" {
		return name
	}
	return dirRel + "/" + name
}
