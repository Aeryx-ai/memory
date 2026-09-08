// Package yamlfm renders and parses the YAML frontmatter of a concept file
// byte for byte the way the Node implementation's yaml@2.9.0 does under
// {lineWidth: 0, schema: "core"}. It covers the value shapes the bundle
// produces: block mappings, block sequences, strings, integers, floats,
// booleans and null. Comments, anchors, tags and flow styles never appear
// in what it writes; flow collections are accepted on parse.
package yamlfm

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
)

// Value is *Map, Seq, string, int64, float64, bool or nil.
type Value = any

type Seq []Value

type Pair struct {
	Key   string
	Value Value
}

// Map keeps insertion order, which is what JavaScript objects and YAML both
// preserve and what the rendered bytes depend on.
type Map struct {
	Pairs []Pair
}

func (m *Map) Get(key string) (Value, bool) {
	for _, p := range m.Pairs {
		if p.Key == key {
			return p.Value, true
		}
	}
	return nil, false
}

func (m *Map) Set(key string, v Value) {
	for i, p := range m.Pairs {
		if p.Key == key {
			m.Pairs[i].Value = v
			return
		}
	}
	m.Pairs = append(m.Pairs, Pair{key, v})
}

func (m *Map) Delete(key string) {
	for i, p := range m.Pairs {
		if p.Key == key {
			m.Pairs = append(m.Pairs[:i], m.Pairs[i+1:]...)
			return
		}
	}
}

func (m *Map) Len() int {
	if m == nil {
		return 0
	}
	return len(m.Pairs)
}

// ParseJSON decodes JSON into a Value with object key order kept. Integer
// literals that fit int64 become int64, other numbers float64.
func ParseJSON(text string) (Value, error) {
	dec := json.NewDecoder(bytes.NewReader([]byte(text)))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing data")
	}
	return v, nil
}

func decodeValue(dec *json.Decoder) (Value, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch v := tok.(type) {
	case json.Delim:
		if v == '{' {
			m := &Map{}
			for dec.More() {
				k, err := dec.Token()
				if err != nil {
					return nil, err
				}
				val, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				m.Pairs = append(m.Pairs, Pair{k.(string), val})
			}
			_, err := dec.Token()
			return m, err
		}
		s := Seq{}
		for dec.More() {
			val, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			s = append(s, val)
		}
		_, err := dec.Token()
		return s, err
	case json.Number:
		if i, err := strconv.ParseInt(v.String(), 10, 64); err == nil {
			return i, nil
		}
		f, err := strconv.ParseFloat(v.String(), 64)
		return f, err
	default:
		return v, nil // string, bool, nil
	}
}
