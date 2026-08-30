import test from "node:test";
import assert from "node:assert/strict";
import { parseSummaryBody, renderSummaryBody, pruneObservations, newId, estimateTokens, isSessionSummaryFor } from "../src/summary.mjs";
const body = `# Reflections\n[b2c3d4e5f6a1] Hard constraint: writes never block <- d4e5f6a1b2c3,e5f6a1b2c3d4\n\n# Observations\n[d4e5f6a1b2c3] 2026-08-29 10:53 [high] Chose OKF v0.2.\n[e5f6a1b2c3d4] 2026-08-29 11:02 [medium] Adopted observations.\n[f6a1b2c3d4e5] 2026-08-29 11:10 [low] Noted the time.\n`;
test("parse and render round trip", () => {
  const s = parseSummaryBody(body);
  assert.equal(s.reflections.length, 1); assert.deepEqual(s.reflections[0].supports, ["d4e5f6a1b2c3", "e5f6a1b2c3d4"]);
  assert.equal(s.observations[2].relevance, "low"); assert.equal(s.observations[0].at, "2026-08-29 10:53");
  assert.equal(renderSummaryBody(s), body);
  assert.equal(renderSummaryBody(parseSummaryBody("")), "# Reflections\n\n# Observations\n");
});
test("malformed lines are dropped, not fatal", () => {
  const s = parseSummaryBody("# Observations\nnot a line\n[abc] bad id\n[d4e5f6a1b2c3] 2026-08-29 10:53 [high] ok\n");
  assert.equal(s.observations.length, 1);
});
test("prune drops covered first, then low relevance oldest first, to target", () => {
  const s = parseSummaryBody(body);
  const big = { ...s, observations: s.observations.map((o) => ({ ...o, content: o.content + " " + "x".repeat(400) })) };
  const r = pruneObservations({ ...big, maxTokens: 200, targetTokens: 120 });
  assert.deepEqual(r.dropped, ["d4e5f6a1b2c3", "e5f6a1b2c3d4"]);
  assert.deepEqual(r.observations.map((o) => o.id), ["f6a1b2c3d4e5"]);
  assert.deepEqual(pruneObservations({ ...s, maxTokens: 10_000, targetTokens: 5_000 }).dropped, []);
});
test("ids and tokens", () => { assert.match(newId(), /^[a-f0-9]{12}$/); assert.equal(estimateTokens("abcd"), 1); assert.equal(estimateTokens("abcde"), 2); });
test("isSessionSummaryFor matches on type and a sources[].resource hit only", () => {
  const summary = { type: "Session Summary", sources: [{ resource: "pi:session/1" }] };
  assert.equal(isSessionSummaryFor(summary, "pi:session/1"), true);
  assert.equal(isSessionSummaryFor(summary, "pi:session/2"), false);
  assert.equal(isSessionSummaryFor({ type: "Project", sources: [{ resource: "pi:session/1" }] }, "pi:session/1"), false);
});
