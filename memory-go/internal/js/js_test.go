package js

import (
	"testing"
	"time"
)

func TestLen16AndSlice16(t *testing.T) {
	cases := []struct {
		s    string
		n    int
		end  int
		want string
	}{
		{"abc", 3, 2, "ab"},
		{"日本語", 3, 1, "日"},
		{"a🎉b", 4, 2, "a"},
		{"a🎉b", 4, 3, "a🎉"},
		{"", 0, 5, ""},
	}
	for _, c := range cases {
		if got := Len16(c.s); got != c.n {
			t.Errorf("Len16(%q) = %d, want %d", c.s, got, c.n)
		}
		if got := Slice16(c.s, c.end); got != c.want {
			t.Errorf("Slice16(%q, %d) = %q, want %q", c.s, c.end, got, c.want)
		}
	}
}

func TestCompareLower(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"a", "B", -1}, {"B", "a", 1}, {"[x]", "Accepted", -1}, {"Same", "same", -1}, {"same", "same", 0},
		{"scanduit repo", "scanduit-cluster", -1}, {"日本", "🎉", -1}, {"￿", "🎉", 1},
	}
	for _, c := range cases {
		if got := CompareLower(c.a, c.b); got != c.want {
			t.Errorf("CompareLower(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestNumber(t *testing.T) {
	cases := map[float64]string{1: "1", -5: "-5", 1.5: "1.5", 1e21: "1e+21", 1e20: "100000000000000000000", 0.000001: "0.000001", 1e-7: "1e-7", 123456789.125: "123456789.125", 100: "100", 0.1: "0.1", -0.5: "-0.5", 1.5e-10: "1.5e-10", 2.5e300: "2.5e+300"}
	for f, want := range cases {
		if got := Number(f); got != want {
			t.Errorf("Number(%v) = %q, want %q", f, got, want)
		}
	}
}

func TestJSONQuote(t *testing.T) {
	cases := map[string]string{
		"plain": `"plain"`, `q"q`: `"q\"q"`, `b\s`: `"b\\s"`, "nl\n": `"nl\n"`, "tab\t": `"tab\t"`,
		"\x00": "\"\\u0000\"", "\x1b": "\"\\u001b\"", "\x7f": "\"\x7f\"", "é/🎉": `"é/🎉"`, "<&>": `"<&>"`, " ": "\" \"",
		"\b\f\r": `"\b\f\r"`,
	}
	for in, want := range cases {
		if got := JSONQuote(in); got != want {
			t.Errorf("JSONQuote(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestJSONStringify(t *testing.T) {
	cases := map[string]string{
		`{"b":1,"a":2}`: `{"b":1,"a":2}`,
		` { "x" : [ 1 , 2.50 , "s" , null , true ] } `: `{"x":[1,2.5,"s",null,true]}`,
		`{"u":"é","big":1e2,"neg":-0.0}`:               `{"u":"é","big":100,"neg":0}`,
		`[]`:                                           `[]`, `{}`: `{}`, `"x"`: `"x"`, `1e21`: `1e+21`,
	}
	for in, want := range cases {
		got, err := JSONStringify([]byte(in))
		if err != nil || got != want {
			t.Errorf("JSONStringify(%s) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := JSONStringify([]byte(`{bad`)); err == nil {
		t.Error("want error on invalid JSON")
	}
}

func TestISOAndTrim(t *testing.T) {
	if got := ISO(time.Date(2026, 9, 7, 16, 36, 26, 195_000_000, time.UTC)); got != "2026-09-07T16:36:26.195Z" {
		t.Errorf("ISO = %q", got)
	}
	if got := ISO(time.Date(2026, 1, 1, 0, 0, 0, 0, time.FixedZone("x", 3600))); got != "2025-12-31T23:00:00.000Z" {
		t.Errorf("ISO zone = %q", got)
	}
	if got := Trim("  x \uFEFF\t "); got != "x" {
		t.Errorf("Trim = %q", got)
	}
	if got := Lower("ΣΑΣ İ"); got != "σας i̇" {
		t.Errorf("Lower = %q", got)
	}
	// Final_Sigma applies only to a Σ the input held upper case; an existing
	// lowercase σ at the end of a word is never rewritten to ς.
	if got := Lower("ασ"); got != "ασ" {
		t.Errorf("Lower(existing final sigma) = %q, want %q", got, "ασ")
	}
}
