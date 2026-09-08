package memory

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
	"github.com/aeryx-ai/memory/memory-go/yamlfm"
)

var statuses = []string{"draft", "stable", "deprecated"}

type Stamp struct {
	By string `json:"by"`
	At string `json:"at,omitempty"`
}

// Source is one OKF sources[] entry. Known keys render in the order Node
// writes them (resource, id, title, last_modified); unknown keys from a
// parsed file follow in their file order.
type Source struct {
	Resource     string
	ID           string
	Title        string
	LastModified string
	Extra        *yamlfm.Map
}

type Concept struct {
	Type        string
	Title       string
	Description string
	Tags        []string
	Status      string
	Generated   Stamp
	Verified    []Stamp
	Sources     []Source
	StaleAfter  yamlfm.Value
	Body        string
	Extra       *yamlfm.Map
}

type CreateInput struct {
	Type, Title, Description string
	Tags                     []string
	Status                   string
	Actor                    string
	At                       time.Time
	Sources                  []Source
	Body                     string
	Verified                 []Stamp
	StaleAfter               yamlfm.Value
	Extra                    *yamlfm.Map
}

func quoteJSON(s string) string { b, _ := json.Marshal(s); return string(b) }

func checkText(field, text string) error {
	if hit := FindSecret(text); hit != nil {
		return Errorf(CodeRefused, "secret (%s) in %s; nothing written", hit.Name, field)
	}
	return nil
}

func sourceKey(s Source) string {
	var id any
	if s.ID != "" {
		id = s.ID
	}
	k, _ := json.Marshal([]any{s.Resource, id})
	return string(k)
}

func checkSources(sources []Source) error {
	seen := map[string]bool{}
	for _, s := range sources {
		if s.Resource == "" {
			return Errorf(CodeRefused, "source needs a resource")
		}
		k := sourceKey(s)
		if seen[k] {
			id := ""
			if s.ID != "" {
				id = " (" + s.ID + ")"
			}
			return Errorf(CodeRefused, "duplicate source %s%s", s.Resource, id)
		}
		seen[k] = true
	}
	return nil
}

func truthy(v yamlfm.Value) bool {
	switch x := v.(type) {
	case nil:
		return false
	case string:
		return x != ""
	case bool:
		return x
	case int64:
		return x != 0
	case float64:
		return x != 0
	}
	return true
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// finish is finish() in src/concept.mjs: the invariant checks in Node's order.
func finish(c *Concept) (*Concept, error) {
	if !IsType(c.Type) {
		return nil, Errorf(CodeRefused, "type %s not in %s", quoteJSON(c.Type), strings.Join(Types, ", "))
	}
	if js.Trim(c.Title) == "" {
		return nil, Errorf(CodeRefused, "title is empty")
	}
	if !contains(statuses, c.Status) {
		return nil, Errorf(CodeRefused, "status %s", c.Status)
	}
	if _, err := ParseActor(c.Generated.By); err != nil {
		return nil, err
	}
	if c.Generated.At == "" {
		return nil, Errorf(CodeRefused, "generated.at missing")
	}
	for _, v := range c.Verified {
		if _, err := ParseActor(v.By); err != nil {
			return nil, err
		}
	}
	if err := checkSources(c.Sources); err != nil {
		return nil, err
	}
	for _, f := range []struct{ name, text string }{{"title", c.Title}, {"description", c.Description}, {"body", c.Body}} {
		if err := checkText(f.name, f.text); err != nil {
			return nil, err
		}
	}
	return c, nil
}

func copyMap(m *yamlfm.Map) *yamlfm.Map {
	out := &yamlfm.Map{}
	if m != nil {
		out.Pairs = append(out.Pairs, m.Pairs...)
	}
	return out
}

func Create(in CreateInput) (*Concept, error) {
	status := in.Status
	if status == "" {
		status = "stable"
	}
	if status != "draft" && status != "stable" {
		return nil, Errorf(CodeRefused, "createConcept cannot start %s; use draft or stable, then deprecate() afterward", quoteJSON(status))
	}
	c := &Concept{
		Type: in.Type, Title: js.Trim(in.Title), Description: js.Trim(in.Description),
		Tags: append([]string{}, in.Tags...), Status: status,
		Generated: Stamp{By: in.Actor, At: js.ISO(in.At)},
		Verified:  append([]Stamp{}, in.Verified...), Sources: append([]Source{}, in.Sources...),
		Body: in.Body, Extra: copyMap(in.Extra),
	}
	if truthy(in.StaleAfter) {
		c.StaleAfter = in.StaleAfter
	}
	return finish(c)
}

// stringOf is String(value ?? "") for the scalar shapes frontmatter carries.
func stringOf(v yamlfm.Value) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case int64:
		return js.Number(float64(x))
	case float64:
		return js.Number(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	}
	return ""
}

func stampOf(v yamlfm.Value) Stamp {
	m, ok := v.(*yamlfm.Map)
	if !ok {
		return Stamp{}
	}
	by, _ := m.Get("by")
	at, _ := m.Get("at")
	byS, _ := by.(string)
	atS, _ := at.(string)
	return Stamp{By: byS, At: atS}
}

func sourceOf(v yamlfm.Value) Source {
	m, ok := v.(*yamlfm.Map)
	if !ok {
		return Source{}
	}
	s := Source{Extra: &yamlfm.Map{}}
	for _, p := range m.Pairs {
		switch p.Key {
		case "resource":
			if str, isStr := p.Value.(string); isStr {
				s.Resource = str
			}
		case "id":
			s.ID = stringOf(p.Value)
		case "title":
			s.Title = stringOf(p.Value)
		case "last_modified":
			s.LastModified = stringOf(p.Value)
		default:
			s.Extra.Pairs = append(s.Extra.Pairs, p)
		}
	}
	return s
}

func ParseConcept(text string) (*Concept, error) {
	data, body, err := yamlfm.ParseDocument(text)
	if err != nil {
		return nil, Errorf(CodeRefused, "%v", err)
	}
	if t, ok := data.Get("type"); !ok || !truthy(t) {
		return nil, Errorf(CodeRefused, "concept has no type")
	}
	c := &Concept{Body: body, Extra: &yamlfm.Map{}, Status: "stable"}
	for _, p := range data.Pairs {
		switch p.Key {
		case "type":
			c.Type = stringOf(p.Value)
		case "title":
			c.Title = js.Trim(stringOf(p.Value))
		case "description":
			c.Description = js.Trim(stringOf(p.Value))
		case "tags":
			if seq, ok := p.Value.(yamlfm.Seq); ok {
				for _, t := range seq {
					c.Tags = append(c.Tags, stringOf(t))
				}
			}
		case "status":
			if p.Value != nil {
				c.Status = stringOf(p.Value)
			}
		case "generated":
			c.Generated = stampOf(p.Value)
		case "verified":
			switch v := p.Value.(type) {
			case nil:
			case yamlfm.Seq:
				for _, item := range v {
					c.Verified = append(c.Verified, stampOf(item))
				}
			default:
				c.Verified = append(c.Verified, stampOf(v))
			}
		case "sources":
			if seq, ok := p.Value.(yamlfm.Seq); ok {
				for _, item := range seq {
					c.Sources = append(c.Sources, sourceOf(item))
				}
			}
		case "stale_after":
			if truthy(p.Value) {
				c.StaleAfter = p.Value
			}
		default:
			c.Extra.Pairs = append(c.Extra.Pairs, p)
		}
	}
	return finish(c)
}

func stampValue(s Stamp) *yamlfm.Map {
	m := &yamlfm.Map{Pairs: []yamlfm.Pair{{Key: "by", Value: s.By}}}
	if s.At != "" {
		m.Pairs = append(m.Pairs, yamlfm.Pair{Key: "at", Value: s.At})
	}
	return m
}

func sourceValue(s Source) *yamlfm.Map {
	m := &yamlfm.Map{Pairs: []yamlfm.Pair{{Key: "resource", Value: s.Resource}}}
	if s.ID != "" {
		m.Pairs = append(m.Pairs, yamlfm.Pair{Key: "id", Value: s.ID})
	}
	if s.Title != "" {
		m.Pairs = append(m.Pairs, yamlfm.Pair{Key: "title", Value: s.Title})
	}
	if s.LastModified != "" {
		m.Pairs = append(m.Pairs, yamlfm.Pair{Key: "last_modified", Value: s.LastModified})
	}
	if s.Extra != nil {
		m.Pairs = append(m.Pairs, s.Extra.Pairs...)
	}
	return m
}

// RenderConcept is renderConcept(): known keys in Node's order, each written
// only when set, then the unknown keys in their own order, then the body.
func RenderConcept(c *Concept) string {
	d := &yamlfm.Map{}
	d.Set("type", c.Type)
	d.Set("title", c.Title)
	if c.Description != "" {
		d.Set("description", c.Description)
	}
	if len(c.Tags) > 0 {
		tags := make(yamlfm.Seq, 0, len(c.Tags))
		for _, t := range c.Tags {
			tags = append(tags, t)
		}
		d.Set("tags", tags)
	}
	d.Set("status", c.Status)
	d.Set("generated", stampValue(c.Generated))
	if len(c.Verified) > 0 {
		v := make(yamlfm.Seq, 0, len(c.Verified))
		for _, s := range c.Verified {
			v = append(v, stampValue(s))
		}
		d.Set("verified", v)
	}
	if len(c.Sources) > 0 {
		s := make(yamlfm.Seq, 0, len(c.Sources))
		for _, src := range c.Sources {
			s = append(s, sourceValue(src))
		}
		d.Set("sources", s)
	}
	if truthy(c.StaleAfter) {
		d.Set("stale_after", c.StaleAfter)
	}
	if c.Extra != nil {
		for _, p := range c.Extra.Pairs {
			d.Set(p.Key, p.Value)
		}
	}
	return yamlfm.RenderDocument(d, c.Body)
}

func ValidateConcept(c *Concept, isRoot bool) error {
	if _, err := finish(clone(c)); err != nil {
		return err
	}
	if !contains(LegalTypes(isRoot), c.Type) {
		where := "project directory"
		if isRoot {
			where = "bundle root"
		}
		return Errorf(CodeRefused, "%s is not allowed at the %s", c.Type, where)
	}
	return nil
}

func clone(c *Concept) *Concept {
	n := *c
	n.Tags = append([]string{}, c.Tags...)
	n.Verified = append([]Stamp{}, c.Verified...)
	n.Sources = append([]Source{}, c.Sources...)
	n.Extra = copyMap(c.Extra)
	return &n
}

func stamp(c *Concept, actor string, at time.Time) (*Concept, error) {
	if _, err := ParseActor(actor); err != nil {
		return nil, err
	}
	n := clone(c)
	n.Generated = Stamp{By: actor, At: js.ISO(at)}
	return n, nil
}

func Deprecate(c *Concept, actor string, at time.Time) (*Concept, error) {
	if c.Status == "deprecated" {
		return nil, Errorf(CodeRefused, "%s is already deprecated", c.Title)
	}
	n, err := stamp(c, actor, at)
	if err != nil {
		return nil, err
	}
	n.Status = "deprecated"
	return finish(n)
}

func Restore(c *Concept, actor string, at time.Time) (*Concept, error) {
	if c.Status == "stable" {
		return nil, Errorf(CodeRefused, "%s is already stable", c.Title)
	}
	n, err := stamp(c, actor, at)
	if err != nil {
		return nil, err
	}
	n.Status = "stable"
	return finish(n)
}

type ReviseFields struct {
	Title, Description, Body *string
	Tags                     *[]string
	Sources                  []Source
	Status                   *string
}

// Revise is revise(): replace the given fields, merge new sources by
// (resource, id), and accept only a promotion to stable.
func Revise(c *Concept, f ReviseFields, actor string, at time.Time) (*Concept, error) {
	n, err := stamp(c, actor, at)
	if err != nil {
		return nil, err
	}
	if f.Title != nil {
		n.Title = *f.Title
	}
	if f.Description != nil {
		n.Description = *f.Description
	}
	if f.Body != nil {
		n.Body = *f.Body
	}
	if f.Tags != nil {
		n.Tags = append([]string{}, (*f.Tags)...)
	}
	if f.Sources != nil {
		have := map[string]bool{}
		for _, s := range c.Sources {
			have[sourceKey(s)] = true
		}
		// have covers the existing sources only, as Node's revise() does; two
		// identical new sources both pass and finish() refuses the duplicate.
		for _, s := range f.Sources {
			if !have[sourceKey(s)] {
				n.Sources = append(n.Sources, s)
			}
		}
	}
	if f.Status != nil {
		if *f.Status != "stable" {
			return nil, Errorf(CodeRefused, "revise cannot set status to %s; use deprecate/restore, or promote a draft with status: \"stable\"", quoteJSON(*f.Status))
		}
		if c.Status != "draft" && c.Status != "stable" {
			return nil, Errorf(CodeRefused, "revise cannot promote %s to stable; restore it first", c.Status)
		}
		n.Status = "stable"
	}
	return finish(n)
}
