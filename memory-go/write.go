package memory

import (
	"regexp"
	"strings"
	"time"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

type RememberInput struct {
	Type, Title string
	Description *string
	Tags        *[]string
	Sources     []string
	Status      *string
	Body        *string
}

type WriteResult struct {
	Rel     string
	Created bool
	Status  string
	Job     Job
}

// Remember is the CLI's remember: create the concept at the slug of its
// title, or revise the one already there. The returned Job regenerates the
// index and commits; the caller runs it, usually off the hot path.
//
// Node's need() only refuses an undefined flag; an explicitly empty --type,
// --title or --session flows through to the checks that already refuse it
// downstream (the type vocabulary check, slugify's empty-slug refusal,
// createConcept's "source needs a resource"), so Go asks nothing extra of
// Type, Title or Session here.
func Remember(b *Bundle, dir Dir, actor string, at time.Time, in RememberInput) (WriteResult, error) {
	if err := requireAt(at); err != nil {
		return WriteResult{}, err
	}
	if !IsType(in.Type) {
		return WriteResult{}, Errorf(CodeRefused, "type %s not in %s", quoteJSON(in.Type), strings.Join(Types, ", "))
	}
	slug, err := Slugify(in.Title)
	if err != nil {
		return WriteResult{}, err
	}
	rel := b.ConceptRel(dir, in.Type, slug)
	sources := make([]Source, 0, len(in.Sources))
	for _, s := range in.Sources {
		sources = append(sources, Source{Resource: s})
	}
	var res WriteResult
	if err := withRememberLock(b.Abs(rel), func() error {
		res, err = rememberLocked(b, dir, actor, at, rel, in, sources)
		return err
	}); err != nil {
		return WriteResult{}, err
	}
	return res, nil
}

// rememberLocked is Remember's body under the per-concept lock.
func rememberLocked(b *Bundle, dir Dir, actor string, at time.Time, rel string, in RememberInput, sources []Source) (WriteResult, error) {
	existing, err := b.ReadConcept(rel)
	if err != nil && CodeOf(err) != CodeNotFound {
		return WriteResult{}, err
	}
	var c *Concept
	if existing != nil {
		title := in.Title
		c, err = Revise(existing, ReviseFields{Title: &title, Description: in.Description, Tags: in.Tags, Body: in.Body, Sources: sources, Status: in.Status}, actor, at)
	} else {
		ci := CreateInput{Type: in.Type, Title: in.Title, Actor: actor, At: at, Sources: sources}
		if in.Description != nil {
			ci.Description = *in.Description
		}
		if in.Tags != nil {
			ci.Tags = *in.Tags
		}
		if in.Status != nil {
			ci.Status = *in.Status
		}
		if in.Body != nil {
			ci.Body = *in.Body
		}
		c, err = Create(ci)
	}
	if err != nil {
		return WriteResult{}, err
	}
	if err := ValidateConcept(c, dir.IsRoot); err != nil {
		return WriteResult{}, err
	}
	kind := LogCreation
	if existing != nil {
		kind = LogUpdate
	}
	if err := writeAndLog(b, dir, kind, rel, c, actor, at); err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Rel: rel, Created: existing == nil, Status: c.Status, Job: Job{DirRel: dir.Rel, Message: "memory: remember " + in.Title}}, nil
}

func writeAndLog(b *Bundle, dir Dir, kind LogKind, rel string, c *Concept, actor string, at time.Time) error {
	if err := b.WriteConcept(rel, c); err != nil {
		return err
	}
	return b.AppendLog(dir, kind, c, rel, actor, at)
}

func transition(b *Bundle, dir Dir, actor string, at time.Time, key string, fn func(*Concept, string, time.Time) (*Concept, error), kind LogKind) (WriteResult, error) {
	if err := requireAt(at); err != nil {
		return WriteResult{}, err
	}
	if key == "" {
		return WriteResult{}, Errorf(CodeUsage, "concept key required")
	}
	e, err := b.FindConcept(dir, key)
	if err != nil {
		return WriteResult{}, err
	}
	next, err := fn(e.Concept, actor, at)
	if err != nil {
		return WriteResult{}, err
	}
	if err := writeAndLog(b, dir, kind, e.Rel, next, actor, at); err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Rel: e.Rel, Status: next.Status, Job: Job{DirRel: dir.Rel, Message: "memory: " + strings.ToLower(string(kind)) + " " + e.Concept.Title}}, nil
}

func DeprecateKey(b *Bundle, dir Dir, actor string, at time.Time, key string) (WriteResult, error) {
	return transition(b, dir, actor, at, key, Deprecate, LogDeprecation)
}

func RestoreKey(b *Bundle, dir Dir, actor string, at time.Time, key string) (WriteResult, error) {
	return transition(b, dir, actor, at, key, Restore, LogUpdate)
}

func Show(b *Bundle, dir Dir, key string) (Entry, error) {
	if key == "" {
		return Entry{}, Errorf(CodeUsage, "--key is required")
	}
	return b.FindConcept(dir, key)
}

var sessionSlugRe = regexp.MustCompile(`(?i)[^a-z0-9]+`)

func sessionSlug(s string) string { return strings.ToLower(sessionSlugRe.ReplaceAllString(s, "-")) }

func utcMinuteRaw(iso string) string { return strings.Replace(iso[:16], "T", " ", 1) }

// UTCMinute is "YYYY-MM-DD HH:MM UTC", the Session Summary title prefix.
func UTCMinute(at time.Time) string { return utcMinuteRaw(js.ISO(at)) + " UTC" }

var fracZ = regexp.MustCompile(`\.\d+Z$`)

// SessionSummaryRel is <dir>/session-summaries/<compact stamp>-<actor slug>.md,
// so two harnesses summarizing at once never collide.
func SessionSummaryRel(b *Bundle, dir Dir, at time.Time, actor string) (string, error) {
	stamp := strings.NewReplacer("-", "", ":", "").Replace(js.ISO(at))
	stamp = fracZ.ReplaceAllString(stamp, "Z")
	slug, err := Slugify(actor)
	if err != nil {
		return "", err
	}
	return b.ConceptRel(dir, "Session Summary", stamp+"-"+slug), nil
}

// Summarize writes body verbatim as the session's Session Summary, revising
// an existing one unless it already holds folded observations.
func Summarize(b *Bundle, dir Dir, actor string, at time.Time, session, body string) (WriteResult, error) {
	if err := requireAt(at); err != nil {
		return WriteResult{}, err
	}
	entries, err := b.ListConcepts(dir)
	if err != nil {
		return WriteResult{}, err
	}
	var existing *Entry
	for i := range entries {
		if IsSessionSummaryFor(entries[i].Concept, session) {
			existing = &entries[i]
			break
		}
	}
	if existing != nil && len(ParseSummaryBody(existing.Concept.Body).Observations) > 0 {
		return WriteResult{}, Errorf(CodeRefused, "session %s already has folded observations at %s; summarize would overwrite them", session, existing.Rel)
	}
	var rel string
	var c *Concept
	if existing != nil {
		rel = existing.Rel
		c, err = Revise(existing.Concept, ReviseFields{Body: &body}, actor, at)
	} else {
		rel, err = SessionSummaryRel(b, dir, at, actor)
		if err != nil {
			return WriteResult{}, err
		}
		c, err = Create(CreateInput{Type: "Session Summary", Title: UTCMinute(at) + " " + actor, Description: "Session " + session, Actor: actor, At: at, Sources: []Source{{Resource: session}}, Body: body})
	}
	if err != nil {
		return WriteResult{}, err
	}
	kind := LogCreation
	if existing != nil {
		kind = LogUpdate
	}
	if err := writeAndLog(b, dir, kind, rel, c, actor, at); err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Rel: rel, Created: existing == nil, Status: c.Status, Job: Job{DirRel: dir.Rel, Message: "memory: summarize " + session}}, nil
}
