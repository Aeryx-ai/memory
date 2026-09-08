package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

type FoldSettings struct {
	ObserveAfterTokens       int
	ReflectAfterTokens       int
	ObservationsMaxTokens    int
	ObservationsTargetTokens int
	ObserverMaxTokens        int
}

var DefaultFoldSettings = FoldSettings{8000, 20000, 20000, 10000, 60000}

func (s FoldSettings) withDefaults() FoldSettings {
	d := DefaultFoldSettings
	if s.ObserveAfterTokens != 0 {
		d.ObserveAfterTokens = s.ObserveAfterTokens
	}
	if s.ReflectAfterTokens != 0 {
		d.ReflectAfterTokens = s.ReflectAfterTokens
	}
	if s.ObservationsMaxTokens != 0 {
		d.ObservationsMaxTokens = s.ObservationsMaxTokens
	}
	if s.ObservationsTargetTokens != 0 {
		d.ObservationsTargetTokens = s.ObservationsTargetTokens
	}
	if s.ObserverMaxTokens != 0 {
		d.ObserverMaxTokens = s.ObserverMaxTokens
	}
	return d
}

const (
	observationMaxChars    = 240
	maxObservationsPerFold = 40
	giveUpAfterFailures    = 3
	foldLockStale          = 15 * time.Minute
)

// Summarizer is the model call fold makes: the port rudy satisfies from its
// Provider context and the CLI satisfies with a shell command.
type Summarizer interface {
	Summarize(prompt string) (string, error)
}

type execSummarizer struct{ cmd string }

// ExecSummarizer runs cmd through sh -c with the prompt on stdin and in the
// file MEMORY_PROMPT_FILE, a 180s timeout and a 16MB output cap, the way
// the Node CLI's --summarize-cmd does.
func ExecSummarizer(cmd string) Summarizer { return execSummarizer{cmd} }

func (e execSummarizer) Summarize(prompt string) (string, error) {
	file := filepath.Join(os.TempDir(), fmt.Sprintf("memory-prompt-%d-%d.txt", os.Getpid(), time.Now().UnixMilli()))
	if err := os.WriteFile(file, []byte(prompt), 0o600); err != nil {
		return "", err
	}
	defer os.Remove(file)
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, "sh", "-c", e.cmd)
	c.Stdin = strings.NewReader(prompt)
	c.Env = append(os.Environ(), "MEMORY_PROMPT_FILE="+file)
	var out bytes.Buffer
	c.Stdout = &out
	c.Stderr = nil
	if err := c.Run(); err != nil {
		return "", fmt.Errorf("summarizer: %w", err)
	}
	if out.Len() > 16<<20 {
		return "", errors.New("summarizer: output over 16MB")
	}
	return out.String(), nil
}

type FoldOptions struct {
	Session    string
	Actor      string
	Transcript string
	Format     string // "" means detect
	ProjectID  string // "" means the root
	Finalize   bool
	Summarizer Summarizer
	Settings   FoldSettings
	Now        time.Time
}

type FoldStatus struct {
	Status       string `json:"status"`
	Reason       string `json:"reason,omitempty"`
	Observations int    `json:"observations"`
	Reflected    bool   `json:"reflected"`
	Dropped      int    `json:"dropped"`
	Error        string `json:"error,omitempty"`
}

type foldError struct {
	At      string `json:"at"`
	Message string `json:"message"`
}

// foldState is the per-session checkpoint under .state/, the same keys Node
// writes so both implementations resume each other's folds on one machine.
type foldState struct {
	Session              string     `json:"session"`
	TranscriptBytes      int64      `json:"transcriptBytes"`
	FoldedAt             *string    `json:"foldedAt"`
	Rel                  *string    `json:"rel"`
	ObservedSinceReflect int        `json:"observedSinceReflect"`
	Failures             *int       `json:"failures,omitempty"`
	LastError            *foldError `json:"lastError,omitempty"`
}

func statePath(b *Bundle, session string) (string, error) {
	return b.StatePath(sessionSlug(session) + ".json")
}

func loadState(b *Bundle, session string) (*foldState, error) {
	p, err := statePath(b, session)
	if err != nil {
		return nil, err
	}
	st := &foldState{Session: session}
	raw, err := os.ReadFile(p)
	if err != nil {
		return st, nil
	}
	if json.Unmarshal(raw, st) != nil {
		return &foldState{Session: session}, nil
	}
	return st, nil
}

func saveState(b *Bundle, st *foldState) error {
	p, err := statePath(b, st.Session)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return os.WriteFile(p, raw, 0o666)
}

// MarkFoldError records a failure against the session's checkpoint so a job
// that died leaves a trail for doctor and the next fold.
func MarkFoldError(b *Bundle, session, message string, at time.Time) error {
	st, err := loadState(b, session)
	if err != nil {
		return err
	}
	st.LastError = &foldError{At: js.ISO(at), Message: message}
	return saveState(b, st)
}

func ObserverPrompt(refl []Reflection, recent []Observation, delta string) string {
	r := make([]string, 0, len(refl))
	for _, x := range refl {
		r = append(r, "["+x.ID+"] "+x.Content)
	}
	o := make([]string, 0, len(recent))
	for _, x := range recent {
		o = append(o, observationLine(x))
	}
	return "You extract observations from a coding-agent transcript delta. Output only lines of the form:\n[relevance] one-line observation | entryId,entryId\nrelevance is one of " + strings.Join(Relevance, ", ") + ". Record decisions, constraints, preferences, completed work, rejected approaches, open items. Skip chatter. Cite the transcript entry ids the observation came from.\n\nExisting reflections:\n" + orNone(strings.Join(r, "\n")) + "\n\nRecent observations:\n" + orNone(strings.Join(o, "\n")) + "\n\nTranscript delta:\n" + delta
}

func ReflectorPrompt(refl []Reflection, obs []Observation) string {
	r := make([]string, 0, len(refl))
	for _, x := range refl {
		r = append(r, "["+x.ID+"] "+x.Content+" <- "+strings.Join(x.Supports, ","))
	}
	o := make([]string, 0, len(obs))
	for _, x := range obs {
		o = append(o, observationLine(x))
	}
	return "You distill durable reflections from observations. Output only lines of the form:\none-line durable fact <- obsId,obsId\nA reflection is a stable fact about the user, project, decision or constraint. Cite every observation whose durable meaning it preserves, and only those.\n\nCurrent reflections:\n" + orNone(strings.Join(r, "\n")) + "\n\nObservations:\n" + strings.Join(o, "\n")
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

// FoldDue is the gate fold() applies before spawning: the transcript bytes
// past the checkpoint, as tokens, against observeAfterTokens. Finalize is
// always due.
func FoldDue(b *Bundle, o FoldOptions) (bool, string, error) {
	st, err := loadState(b, o.Session)
	if err != nil {
		return false, "", err
	}
	var size int64
	if info, err := os.Stat(o.Transcript); err == nil {
		size = info.Size()
	}
	if size < st.TranscriptBytes {
		st.TranscriptBytes = 0
	}
	settings := o.Settings.withDefaults()
	pending := (max(0, size-st.TranscriptBytes) + 3) / 4
	if !o.Finalize && int(pending) < settings.ObserveAfterTokens {
		return false, fmt.Sprintf("%d tokens pending", pending), nil
	}
	return true, "", nil
}

// RunFoldJob is runFoldJob(): single flight per session under
// .locks/fold-<session slug>, skipped when there is nothing it can do.
func RunFoldJob(b *Bundle, o FoldOptions) (FoldStatus, error) {
	hasSummarizer := o.Summarizer != nil
	if !hasSummarizer && !o.Finalize {
		return FoldStatus{Status: "skipped", Reason: "no summarizer"}, nil
	}
	if hasSummarizer {
		if _, err := os.Stat(o.Transcript); err != nil {
			return FoldStatus{Status: "skipped", Reason: "no transcript"}, nil
		}
	}
	var result FoldStatus
	ran, err := WithLock(b.Root, "fold-"+sessionSlug(o.Session), foldLockStale, func() error {
		var err error
		result, err = runFold(b, o)
		return err
	})
	if err != nil {
		return FoldStatus{}, err
	}
	if !ran {
		return FoldStatus{Status: "skipped", Reason: "locked"}, nil
	}
	return result, nil
}

var (
	obsOut = regexp.MustCompile(`^\[(low|medium|high|critical)\]\s+(.+?)\s*\|\s*([A-Za-z0-9,_-]+)\s*$`)
	refOut = regexp.MustCompile(`^(.+?)\s*<-\s*([a-f0-9]{12}(?:,[a-f0-9]{12})*)\s*$`)
)

func truncateObservation(content string) string {
	if js.Len16(content) > observationMaxChars {
		return js.Slice16(content, observationMaxChars) + "…"
	}
	return content
}

func promoteToStable(b *Bundle, dir Dir, st *foldState, rel string, c *Concept, actor, now string, session string) (FoldStatus, error) {
	at, _ := time.Parse(time.RFC3339Nano, now)
	stable := "stable"
	revised, err := Revise(c, ReviseFields{Status: &stable}, actor, at)
	if err != nil {
		st.LastError = &foldError{At: now, Message: err.Error()}
		if err := saveState(b, st); err != nil {
			return FoldStatus{}, err
		}
		return FoldStatus{Status: "folded", Error: err.Error()}, nil
	}
	if err := writeAndLog(b, dir, LogUpdate, rel, revised, actor, at); err != nil {
		return FoldStatus{}, err
	}
	Job{DirRel: dir.Rel, Message: "memory: fold " + session}.Run(b)
	return FoldStatus{Status: "folded"}, nil
}

func giveUpOrRetry(b *Bundle, st *foldState, rel string, cause error, bytes int64, now string) (FoldStatus, error) {
	failures := 1
	if st.Failures != nil {
		failures = *st.Failures + 1
	}
	st.Failures = &failures
	if failures >= giveUpAfterFailures {
		st.LastError = &foldError{At: now, Message: fmt.Sprintf("%s (delta abandoned after %d consecutive summarizer failures)", cause.Error(), giveUpAfterFailures)}
		st.Rel, st.TranscriptBytes, st.FoldedAt = &rel, bytes, &now
	} else {
		st.LastError = &foldError{At: now, Message: cause.Error()}
	}
	if err := saveState(b, st); err != nil {
		return FoldStatus{}, err
	}
	return FoldStatus{Status: "folded", Error: st.LastError.Message}, nil
}

func runFold(b *Bundle, o FoldOptions) (FoldStatus, error) {
	st, err := loadState(b, o.Session)
	if err != nil {
		return FoldStatus{}, err
	}
	dir, err := b.Dir(o.ProjectID)
	if err != nil {
		return FoldStatus{}, err
	}
	nowT := o.Now.UTC()
	now := js.ISO(nowT)
	var rel string
	var concept *Concept
	if st.Rel != nil {
		if c, err := b.ReadConcept(*st.Rel); err == nil {
			rel, concept = *st.Rel, c
		}
	}
	if rel == "" {
		entries, err := b.ListConcepts(dir)
		if err != nil {
			return FoldStatus{}, err
		}
		for _, e := range entries {
			if IsSessionSummaryFor(e.Concept, o.Session) {
				rel, concept = e.Rel, e.Concept
				break
			}
		}
	}
	if o.Summarizer == nil {
		if rel == "" {
			return FoldStatus{Status: "skipped", Reason: "no summarizer"}, nil
		}
		return promoteToStable(b, dir, st, rel, concept, o.Actor, now, o.Session)
	}
	settings := o.Settings.withDefaults()
	format := o.Format
	if format == "" {
		if format, err = DetectFormat(o.Transcript); err != nil {
			return FoldStatus{}, err
		}
	}
	if rel == "" {
		rel, err = SessionSummaryRel(b, dir, nowT, o.Actor)
		if err != nil {
			return FoldStatus{}, err
		}
		concept, err = Create(CreateInput{Type: "Session Summary", Title: UTCMinute(nowT) + " " + o.Actor, Description: "Session " + o.Session, Status: "draft", Actor: o.Actor, At: nowT, Sources: []Source{{Resource: o.Session}, {Resource: o.Transcript, Title: "transcript"}}, Body: RenderSummaryBody(SummaryBody{})})
		if err != nil {
			return FoldStatus{}, err
		}
		if err := writeAndLog(b, dir, LogCreation, rel, concept, o.Actor, nowT); err != nil {
			return FoldStatus{}, err
		}
	}
	st.Rel = &rel
	if err := saveState(b, st); err != nil {
		return FoldStatus{}, err
	}
	entries, bytes, err := ReadDelta(o.Transcript, format, st.TranscriptBytes)
	if err != nil {
		return FoldStatus{}, err
	}
	body := ParseSummaryBody(concept.Body)
	var added []Observation
	var sources []Source
	if len(entries) > 0 {
		capped := CapDelta(entries, settings.ObserverMaxTokens)
		recent := body.Observations
		if len(recent) > 20 {
			recent = recent[len(recent)-20:]
		}
		out, err := o.Summarizer.Summarize(ObserverPrompt(body.Reflections, recent, SerializeEntries(capped)))
		if err != nil {
			return giveUpOrRetry(b, st, rel, err, bytes, now)
		}
		byID := map[string]TranscriptEntry{}
		for _, e := range capped {
			byID[e.ID] = e
		}
		lines := strings.Split(out, "\n")
		if len(lines) > maxObservationsPerFold {
			lines = lines[:maxObservationsPerFold]
		}
		for _, line := range lines {
			m := obsOut.FindStringSubmatch(js.Trim(line))
			if m == nil {
				continue
			}
			var ids []string
			for _, id := range strings.Split(m[3], ",") {
				if _, ok := byID[id]; ok {
					ids = append(ids, id)
				}
			}
			if len(ids) == 0 {
				continue
			}
			content := truncateObservation(m[2])
			if FindSecret(content) != nil {
				continue
			}
			at := byID[ids[0]].At
			if at == "" {
				at = now
			}
			id := NewID()
			added = append(added, Observation{ID: id, At: utcMinuteRaw(at), Relevance: m[1], Content: content})
			sources = append(sources, Source{Resource: strings.Join(ids, ","), ID: id})
		}
	}
	body.Observations = append(body.Observations, added...)
	var contents []string
	for _, a := range added {
		contents = append(contents, a.Content)
	}
	st.ObservedSinceReflect += EstimateTokens(strings.Join(contents, "\n"))
	reflected := false
	if len(body.Observations) > 0 && st.ObservedSinceReflect >= settings.ReflectAfterTokens {
		out, err := o.Summarizer.Summarize(ReflectorPrompt(body.Reflections, body.Observations))
		if err != nil {
			st.LastError = &foldError{At: now, Message: "reflector: " + err.Error()}
		} else {
			known := map[string]bool{}
			for _, ob := range body.Observations {
				known[ob.ID] = true
			}
			var next []Reflection
			for _, line := range strings.Split(out, "\n") {
				m := refOut.FindStringSubmatch(js.Trim(line))
				if m == nil {
					continue
				}
				content := js.Trim(m[1])
				if content == "" || FindSecret(content) != nil {
					continue
				}
				supports := []string{}
				for _, id := range strings.Split(m[2], ",") {
					if known[id] {
						supports = append(supports, id)
					}
				}
				next = append(next, Reflection{ID: NewID(), Content: content, Supports: supports})
			}
			if len(next) > 0 {
				body.Reflections = next
				reflected = true
			}
		}
		st.ObservedSinceReflect = 0
	}
	pinned := map[string]bool{}
	for _, r := range body.Reflections {
		for _, id := range r.Supports {
			pinned[id] = true
		}
	}
	kept, dropped := PruneObservations(body.Observations, body.Reflections, settings.ObservationsMaxTokens, settings.ObservationsTargetTokens)
	body.Observations = kept
	droppedSet := map[string]bool{}
	for _, id := range dropped {
		droppedSet[id] = true
	}
	base := clone(concept)
	base.Sources = nil
	for _, s := range concept.Sources {
		if s.ID == "" || pinned[s.ID] || !droppedSet[s.ID] {
			base.Sources = append(base.Sources, s)
		}
	}
	rendered := RenderSummaryBody(body)
	if sources == nil {
		sources = []Source{} // Node passes an empty array, which still runs the merge
	}
	fields := ReviseFields{Body: &rendered, Sources: sources}
	if o.Finalize {
		stable := "stable"
		fields.Status = &stable
	}
	revised, err := Revise(base, fields, o.Actor, nowT)
	if err != nil {
		st.LastError = &foldError{At: now, Message: err.Error()}
		st.Rel, st.TranscriptBytes, st.FoldedAt = &rel, bytes, &now
		if err := saveState(b, st); err != nil {
			return FoldStatus{}, err
		}
		return FoldStatus{Status: "folded", Error: err.Error()}, nil
	}
	if err := writeAndLog(b, dir, LogUpdate, rel, revised, o.Actor, nowT); err != nil {
		return FoldStatus{}, err
	}
	Job{DirRel: dir.Rel, Message: "memory: fold " + o.Session}.Run(b)
	if len(entries) > 0 {
		st.LastError = nil
		zero := 0
		st.Failures = &zero
	}
	st.Rel, st.TranscriptBytes, st.FoldedAt = &rel, bytes, &now
	if err := saveState(b, st); err != nil {
		return FoldStatus{}, err
	}
	return FoldStatus{Status: "folded", Observations: len(added), Reflected: reflected, Dropped: len(dropped)}, nil
}
