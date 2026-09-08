package memory

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"strings"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

type Observation struct {
	ID        string `json:"id"`
	At        string `json:"at"`
	Relevance string `json:"relevance"`
	Content   string `json:"content"`
}

type Reflection struct {
	ID       string   `json:"id"`
	Content  string   `json:"content"`
	Supports []string `json:"supports"`
}

type SummaryBody struct {
	Reflections  []Reflection  `json:"reflections"`
	Observations []Observation `json:"observations"`
}

var Relevance = []string{"low", "medium", "high", "critical"}

var (
	obsLine = regexp.MustCompile(`^\[([a-f0-9]{12})\] (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \[(low|medium|high|critical)\] (.+)$`)
	refLine = regexp.MustCompile(`^\[([a-f0-9]{12})\] (.+?)(?: <- ([a-f0-9]{12}(?:,[a-f0-9]{12})*))?$`)
)

// NewID is six random bytes as twelve hex characters.
func NewID() string {
	var b [6]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// EstimateTokens is ceil(bytes / 4).
func EstimateTokens(text string) int { return (len(text) + 3) / 4 }

// IsSessionSummaryFor is the one predicate deciding whether a concept is the
// running Session Summary for a session resource.
func IsSessionSummaryFor(c *Concept, session string) bool {
	if c.Type != "Session Summary" {
		return false
	}
	for _, s := range c.Sources {
		if s.Resource == session {
			return true
		}
	}
	return false
}

func ParseSummaryBody(body string) SummaryBody {
	out := SummaryBody{Reflections: []Reflection{}, Observations: []Observation{}}
	section := ""
	for _, raw := range strings.Split(body, "\n") {
		line := js.TrimEnd(raw)
		switch line {
		case "# Reflections":
			section = "r"
			continue
		case "# Observations":
			section = "o"
			continue
		}
		if line == "" || section == "" {
			continue
		}
		if section == "o" {
			if m := obsLine.FindStringSubmatch(line); m != nil {
				out.Observations = append(out.Observations, Observation{ID: m[1], At: m[2], Relevance: m[3], Content: m[4]})
			}
		} else if m := refLine.FindStringSubmatch(line); m != nil {
			supports := []string{}
			if m[3] != "" {
				supports = strings.Split(m[3], ",")
			}
			out.Reflections = append(out.Reflections, Reflection{ID: m[1], Content: m[2], Supports: supports})
		}
	}
	return out
}

func observationLine(o Observation) string {
	return "[" + o.ID + "] " + o.At + " [" + o.Relevance + "] " + o.Content
}

func RenderSummaryBody(s SummaryBody) string {
	var b strings.Builder
	b.WriteString("# Reflections\n")
	for _, r := range s.Reflections {
		b.WriteString("[" + r.ID + "] " + r.Content)
		if len(r.Supports) > 0 {
			b.WriteString(" <- " + strings.Join(r.Supports, ","))
		}
		b.WriteString("\n")
	}
	b.WriteString("\n# Observations\n")
	for _, o := range s.Observations {
		b.WriteString(observationLine(o) + "\n")
	}
	return b.String()
}

func observationTokens(obs []Observation) int {
	var b strings.Builder
	for _, o := range obs {
		b.WriteString(observationLine(o) + "\n")
	}
	return EstimateTokens(b.String())
}

// PruneObservations drops nothing under maxTokens; over it, drops
// observations a reflection covers first (oldest first), then each
// relevance level from low upward (oldest first), until under targetTokens.
func PruneObservations(obs []Observation, refl []Reflection, maxTokens, targetTokens int) ([]Observation, []string) {
	if observationTokens(obs) <= maxTokens {
		return obs, []string{}
	}
	covered := map[string]bool{}
	for _, r := range refl {
		for _, id := range r.Supports {
			covered[id] = true
		}
	}
	live := append([]Observation{}, obs...)
	dropped := []string{}
	dropFirst := func(pred func(Observation) bool) bool {
		for i, o := range live {
			if pred(o) {
				dropped = append(dropped, o.ID)
				live = append(live[:i], live[i+1:]...)
				return true
			}
		}
		return false
	}
	for observationTokens(live) > targetTokens && dropFirst(func(o Observation) bool { return covered[o.ID] }) {
	}
	for _, level := range Relevance {
		for observationTokens(live) > targetTokens && dropFirst(func(o Observation) bool { return o.Relevance == level }) {
		}
	}
	return live, dropped
}
