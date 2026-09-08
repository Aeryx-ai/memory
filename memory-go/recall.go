package memory

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

type Hit struct {
	Rel         string `json:"rel"`
	Score       int    `json:"score"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Type        string `json:"type"`
	Status      string `json:"status"`
}

var termSplit = regexp.MustCompile(`[^a-z0-9]+`)

func count(text, term string) int { return strings.Count(js.Lower(text), term) }

// Recall is recall(): term matches over title, tags, description and body,
// weighted 3, 2, 2, 1, over the root plus the project, ranked by score then
// newest generated.at. An empty query returns everything.
func Recall(b *Bundle, projectID, typ, query string, includeDeprecated bool) ([]Hit, error) {
	if err := requireBundle(b); err != nil {
		return nil, err
	}
	root, _ := b.Dir("")
	dirs := []Dir{root}
	if projectID != "" {
		d, err := b.Dir(projectID)
		if err != nil {
			return nil, err
		}
		dirs = append(dirs, d)
	}
	var terms []string
	for _, t := range termSplit.Split(js.Lower(query), -1) {
		if js.Len16(t) >= 2 {
			terms = append(terms, t)
		}
	}
	type scored struct {
		Hit
		at string
	}
	var out []scored
	for _, dir := range dirs {
		entries, err := b.ListConcepts(dir)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			c := e.Concept
			if !includeDeprecated && c.Status == "deprecated" {
				continue
			}
			if typ != "" && c.Type != typ {
				continue
			}
			score := 0
			for _, t := range terms {
				tagHits := 0
				for _, g := range c.Tags {
					if strings.Contains(js.Lower(g), t) {
						tagHits++
					}
				}
				score += 3*count(c.Title, t) + 2*tagHits + 2*count(c.Description, t) + count(c.Body, t)
			}
			if len(terms) > 0 && score == 0 {
				continue
			}
			out = append(out, scored{Hit{Rel: e.Rel, Score: score, Title: c.Title, Description: c.Description, Type: c.Type, Status: c.Status}, c.Generated.At})
		}
	}
	slices.SortStableFunc(out, func(x, y scored) int {
		if x.Score != y.Score {
			return y.Score - x.Score
		}
		return CompareFold(y.at, x.at)
	})
	hits := make([]Hit, 0, len(out))
	for _, s := range out {
		hits = append(hits, s.Hit)
	}
	return hits, nil
}

type ObservationHit struct {
	ID      string            `json:"id"`
	Line    any               `json:"line"`
	Entries []TranscriptEntry `json:"entries"`
	Reason  string            `json:"reason,omitempty"`
}

func underHome(p, home string) bool {
	abs, err := filepath.Abs(p)
	if err != nil {
		return false
	}
	return abs == home || strings.HasPrefix(abs, home+string(filepath.Separator))
}

// RecallObservation is recall-observation: the transcript entries behind one
// observation or reflection id, searched in the root then the project.
// A transcript outside home is refused rather than followed.
func RecallObservation(b *Bundle, projectID, id, home string) (ObservationHit, error) {
	if id == "" {
		return ObservationHit{}, Errorf(CodeUsage, "observation id required")
	}
	if err := requireBundle(b); err != nil {
		return ObservationHit{}, err
	}
	root, _ := b.Dir("")
	proj, err := b.Dir(projectID)
	if err != nil {
		return ObservationHit{}, err
	}
	for _, dir := range []Dir{root, proj} {
		entries, err := b.ListConcepts(dir)
		if err != nil {
			return ObservationHit{}, err
		}
		for _, e := range entries {
			c := e.Concept
			if c.Type != "Session Summary" {
				continue
			}
			body := ParseSummaryBody(c.Body)
			var line any
			var ids []string
			for _, o := range body.Observations {
				if o.ID == id {
					line, ids = o, []string{id}
				}
			}
			if line == nil {
				for _, r := range body.Reflections {
					if r.ID == id {
						line, ids = r, r.Supports
					}
				}
			}
			if line == nil {
				continue
			}
			var entryIDs []string
			for _, s := range c.Sources {
				if s.ID != "" && slices.Contains(ids, s.ID) {
					entryIDs = append(entryIDs, strings.Split(s.Resource, ",")...)
				}
			}
			transcript := ""
			for _, s := range c.Sources {
				if s.Title == "transcript" {
					transcript = s.Resource
					break
				}
			}
			if transcript != "" && !underHome(transcript, home) {
				return ObservationHit{ID: id, Line: line, Entries: []TranscriptEntry{}, Reason: "transcript outside home"}, nil
			}
			result := []TranscriptEntry{}
			if transcript != "" {
				if _, err := os.Stat(transcript); err == nil {
					format, err := DetectFormat(transcript)
					if err != nil {
						return ObservationHit{}, err
					}
					result, err = ReadEntries(transcript, format, entryIDs)
					if err != nil {
						return ObservationHit{}, err
					}
				}
			}
			return ObservationHit{ID: id, Line: line, Entries: result}, nil
		}
	}
	return ObservationHit{}, Errorf(CodeNotFound, "no observation or reflection %s", id)
}
