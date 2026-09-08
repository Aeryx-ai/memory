package memory

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const goldenDir = "testdata/golden"

type caseResult struct {
	Input    json.RawMessage `json:"input"`
	OK       json.RawMessage `json:"ok"`
	Error    string          `json:"error"`
	Message  string          `json:"message"`
	Expected json.RawMessage `json:"expected"`
}

type goldenCases struct {
	Slug            []caseResult `json:"slug"`
	Actor           []caseResult `json:"actor"`
	Secret          []caseResult `json:"secret"`
	ProjectID       []caseResult `json:"projectid"`
	AssertProjectID []caseResult `json:"assertProjectID"`
	SummaryBodies   []struct {
		Input    string          `json:"input"`
		Parsed   json.RawMessage `json:"parsed"`
		Rendered string          `json:"rendered"`
	} `json:"summaryBodies"`
	Prune []struct {
		Input struct {
			MaxTokens    int           `json:"maxTokens"`
			TargetTokens int           `json:"targetTokens"`
			Reflections  []Reflection  `json:"reflections"`
			Observations []Observation `json:"observations"`
		} `json:"input"`
		Expected struct {
			Observations []Observation `json:"observations"`
			Dropped      []string      `json:"dropped"`
		} `json:"expected"`
	} `json:"prune"`
	Prompts struct {
		Input struct {
			Reflections  []Reflection  `json:"reflections"`
			Observations []Observation `json:"observations"`
			Delta        string        `json:"delta"`
		} `json:"input"`
		Observer  string `json:"observer"`
		Reflector string `json:"reflector"`
	} `json:"prompts"`
	EstimateTokens []struct {
		Input    string `json:"input"`
		Expected int    `json:"expected"`
	} `json:"estimateTokens"`
	UTCMinute []struct {
		Input    string `json:"input"`
		Expected string `json:"expected"`
	} `json:"utcMinute"`
	SessionSlug []struct {
		Input    string `json:"input"`
		Expected string `json:"expected"`
	} `json:"sessionSlug"`
	CapDelta struct {
		Input struct {
			MaxTokens int               `json:"maxTokens"`
			Entries   []TranscriptEntry `json:"entries"`
		} `json:"input"`
		Expected []TranscriptEntry `json:"expected"`
	} `json:"capDelta"`
}

func loadCases(t *testing.T) goldenCases {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(goldenDir, "cases.json"))
	if err != nil {
		t.Fatalf("goldens missing; run make goldens: %v", err)
	}
	var c goldenCases
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func str(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("not a string: %s", raw)
	}
	return s
}

func TestSlugGolden(t *testing.T) {
	for _, c := range loadCases(t).Slug {
		got, err := Slugify(str(t, c.Input))
		if c.Error != "" {
			if CodeOf(err) != Code(c.Error) {
				t.Errorf("Slugify(%s): got %q, %v; want error %s", c.Input, got, err, c.Error)
			}
			if err == nil || err.Error() != c.Message {
				t.Errorf("Slugify(%s) message = %v; want %q", c.Input, err, c.Message)
			}
			continue
		}
		if err != nil || got != str(t, c.OK) {
			t.Errorf("Slugify(%s) = %q, %v; want %s", c.Input, got, err, c.OK)
		}
	}
}

func TestActorGolden(t *testing.T) {
	for _, c := range loadCases(t).Actor {
		got, err := ParseActor(str(t, c.Input))
		if c.Error != "" {
			if CodeOf(err) != Code(c.Error) {
				t.Errorf("ParseActor(%s): want error %s, got %v", c.Input, c.Error, err)
			}
			if err == nil || err.Error() != c.Message {
				t.Errorf("ParseActor(%s) message = %v; want %q", c.Input, err, c.Message)
			}
			continue
		}
		var want Actor
		json.Unmarshal(c.OK, &want)
		if err != nil || got != want {
			t.Errorf("ParseActor(%s) = %+v, %v; want %+v", c.Input, got, err, want)
		}
	}
}

func TestSecretGolden(t *testing.T) {
	for _, c := range loadCases(t).Secret {
		got := FindSecret(str(t, c.Input))
		if string(c.Expected) == "null" {
			if got != nil {
				t.Errorf("FindSecret(%s) = %+v, want nil", c.Input, got)
			}
			continue
		}
		var want SecretHit
		json.Unmarshal(c.Expected, &want)
		if got == nil || *got != want {
			t.Errorf("FindSecret(%s) = %+v, want %+v", c.Input, got, want)
		}
	}
}
