package memory

import (
	"fmt"
	"testing"
)

func TestExitCodesAndCodeOf(t *testing.T) {
	for code, n := range map[Code]int{CodeUsage: 1, CodeNotFound: 2, CodeRefused: 3, CodeCheck: 4, CodeSync: 5, Code("x"): 1} {
		if ExitCode(code) != n {
			t.Errorf("ExitCode(%s) = %d, want %d", code, ExitCode(code), n)
		}
	}
	err := fmt.Errorf("wrap: %w", Errorf(CodeRefused, "title is empty"))
	if CodeOf(err) != CodeRefused || CodeOf(fmt.Errorf("plain")) != "" {
		t.Error("CodeOf")
	}
	if LegalTypes(true)[len(LegalTypes(true))-1] != "Session Summary" || len(LegalTypes(false)) != 4 || LegalTypes(false)[0] != "Feedback" {
		t.Error("LegalTypes")
	}
}
