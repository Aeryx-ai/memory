import test from "node:test";
import assert from "node:assert/strict";
import { compareFold } from "../src/compare.mjs";
test("compareFold lowercases first, then breaks ties on the raw string", () => {
  assert.equal(compareFold("a", "B"), -1);
  assert.equal(compareFold("B", "a"), 1);
  assert.equal(compareFold("[x]", "Accepted"), -1);
  assert.equal(compareFold("scanduit repo", "scanduit-cluster"), -1);
  assert.equal(compareFold("guygrigsby's acceptance", "guygrigsby's Claude"), -1);
  assert.equal(compareFold("guygrigsby's Claude", "guygrigsby's CLI"), -1);
  assert.equal(compareFold("Same", "same"), -1);
  assert.equal(compareFold("same", "same"), 0);
  assert.equal(compareFold("2026-08-29T10:00:00Z", "2026-08-28T10:00:00Z"), 1);
  assert.equal(compareFold("日本", "🎉"), -1);
});
test("the real bundle's index order is unchanged by the comparator", () => {
  const titles = ["Accepted workflow", "[correction] pi", "Cross-repo seam", "DDL and proxy", "guygrigsby expects", "guygrigsby's acceptance", "guygrigsby's Claude", "guygrigsby's CLI", "Never hardcode", "scanduit repo", "scanduit-cluster config", "When design"];
  const sorted = [...titles].sort(compareFold);
  assert.deepEqual(sorted, ["[correction] pi", "Accepted workflow", "Cross-repo seam", "DDL and proxy", "guygrigsby expects", "guygrigsby's acceptance", "guygrigsby's Claude", "guygrigsby's CLI", "Never hardcode", "scanduit repo", "scanduit-cluster config", "When design"]);
});
