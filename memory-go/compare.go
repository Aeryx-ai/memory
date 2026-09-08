package memory

import (
	"slices"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

// CompareFold is the ordering every stored or rendered list uses, shared
// byte for byte with src/compare.mjs.
func CompareFold(a, b string) int { return js.CompareLower(a, b) }

func SortFold(ss []string) { slices.SortStableFunc(ss, CompareFold) }
