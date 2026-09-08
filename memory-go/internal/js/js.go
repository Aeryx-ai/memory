// Package js reproduces the JavaScript semantics the Node implementation
// depends on for bytes it writes: UTF-16 string lengths and slices, Number
// formatting, JSON.stringify and toISOString.
package js

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

func Len16(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// Slice16 is s.slice(0, end) on UTF-16 code units. A cut inside a surrogate
// pair drops the pair, since a lone surrogate cannot be encoded in UTF-8.
func Slice16(s string, end int) string {
	if end <= 0 {
		return ""
	}
	n := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if n+w > end {
			return s[:i]
		}
		n += w
	}
	return s
}

// Lower is String.prototype.toLowerCase: Go's ToLower plus the two
// SpecialCasing rules JavaScript applies that Go's ToLower does not: the
// final sigma, and U+0130 lowering to "i" plus a combining dot above.
func Lower(s string) string {
	l := strings.ToLower(strings.ReplaceAll(s, "İ", "i̇"))
	if !strings.ContainsRune(l, 'σ') {
		return l
	}
	rs := []rune(l)
	for i, r := range rs {
		if r != 'σ' {
			continue
		}
		before := i > 0 && unicode.IsLetter(rs[i-1])
		after := i+1 < len(rs) && unicode.IsLetter(rs[i+1])
		if before && !after {
			rs[i] = 'ς'
		}
	}
	return string(rs)
}

func units(s string) []uint16 { return utf16.Encode([]rune(s)) }

func compareUnits(a, b []uint16) int {
	for i := range min(len(a), len(b)) {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	}
	return 0
}

// CompareLower orders by the lowercased strings' UTF-16 code units, then by
// the raw strings' code units. The one comparator shared with src/compare.mjs.
func CompareLower(a, b string) int {
	if c := compareUnits(units(Lower(a)), units(Lower(b))); c != 0 {
		return c
	}
	return compareUnits(units(a), units(b))
}

// Number is Number.prototype.toString for a double: shortest round trip
// digits, fixed notation for exponents in [-7, 21), else d.ddde±x.
func Number(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde±xx
	mant, expS, _ := strings.Cut(e, "e")
	exp, _ := strconv.Atoi(expS)
	if exp > -7 && exp < 21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	sign := "+"
	if exp < 0 {
		sign = "-"
		exp = -exp
	}
	return mant + "e" + sign + strconv.Itoa(exp)
}

// JSONQuote is JSON.stringify(string): escapes only the quote, the backslash
// and control characters below 0x20, never HTML characters or U+2028.
func JSONQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// JSONStringify is JSON.stringify(JSON.parse(raw)): compact, key order kept,
// numbers reformatted the JavaScript way, strings requoted by JSONQuote.
func JSONStringify(raw []byte) (string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var b strings.Builder
	if err := stringifyValue(dec, &b); err != nil {
		return "", err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return "", errors.New("trailing data after JSON value")
	}
	return b.String(), nil
}

func stringifyValue(dec *json.Decoder, b *strings.Builder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	switch v := tok.(type) {
	case json.Delim:
		switch v {
		case '{':
			b.WriteByte('{')
			first := true
			for dec.More() {
				if !first {
					b.WriteByte(',')
				}
				first = false
				k, err := dec.Token()
				if err != nil {
					return err
				}
				b.WriteString(JSONQuote(k.(string)))
				b.WriteByte(':')
				if err := stringifyValue(dec, b); err != nil {
					return err
				}
			}
			if _, err := dec.Token(); err != nil {
				return err
			}
			b.WriteByte('}')
		case '[':
			b.WriteByte('[')
			first := true
			for dec.More() {
				if !first {
					b.WriteByte(',')
				}
				first = false
				if err := stringifyValue(dec, b); err != nil {
					return err
				}
			}
			if _, err := dec.Token(); err != nil {
				return err
			}
			b.WriteByte(']')
		}
	case string:
		b.WriteString(JSONQuote(v))
	case json.Number:
		f, err := strconv.ParseFloat(v.String(), 64)
		if err != nil {
			return err
		}
		b.WriteString(Number(f))
	case bool:
		b.WriteString(strconv.FormatBool(v))
	case nil:
		b.WriteString("null")
	}
	return nil
}

func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// Trim is String.prototype.trim: Unicode White_Space plus the BOM.
func Trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' })
}
