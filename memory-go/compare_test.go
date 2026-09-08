package memory

import "testing"

func TestCompareFoldMatchesNode(t *testing.T) {
	titles := []string{"Accepted workflow", "[correction] pi", "Cross-repo seam", "DDL and proxy", "guygrigsby expects", "guygrigsby's acceptance", "guygrigsby's Claude", "guygrigsby's CLI", "Never hardcode", "scanduit repo", "scanduit-cluster config", "When design"}
	SortFold(titles)
	want := []string{"[correction] pi", "Accepted workflow", "Cross-repo seam", "DDL and proxy", "guygrigsby expects", "guygrigsby's acceptance", "guygrigsby's Claude", "guygrigsby's CLI", "Never hardcode", "scanduit repo", "scanduit-cluster config", "When design"}
	for i := range want {
		if titles[i] != want[i] {
			t.Fatalf("position %d: got %q, want %q", i, titles[i], want[i])
		}
	}
}
