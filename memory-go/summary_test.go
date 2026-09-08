package memory

import "testing"

// TestParseSummaryBodyTrimsNonBreakingSpace matches Node's raw.trimEnd(),
// which strips Unicode whitespace (including U+00A0) off the end of each
// line before comparing it against "# Observations".
func TestParseSummaryBodyTrimsNonBreakingSpace(t *testing.T) {
	body := "# Observations \n[abc123abc123] 2026-01-01 00:00 [low] noted\n"
	got := ParseSummaryBody(body)
	if len(got.Observations) != 1 {
		t.Fatalf("ParseSummaryBody with trailing NBSP on heading: got %d observations, want 1: %+v", len(got.Observations), got)
	}
	if got.Observations[0].Content != "noted" {
		t.Errorf("Observations[0].Content = %q, want %q", got.Observations[0].Content, "noted")
	}
}
