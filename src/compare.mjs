// The one string comparator for every ordering the bundle stores or renders
// (index entries, concept lists, recall hits, summaries by timestamp).
// Deterministic across Node builds and reproducible in Go: compare the
// lowercased strings by UTF-16 code unit, then the raw strings the same way.
// localeCompare is ICU collation and differs between Node versions, which
// would make two machines regenerate one index.md differently.
function units(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
export function compareFold(a, b) {
  return units(a.toLowerCase(), b.toLowerCase()) || units(a, b);
}
