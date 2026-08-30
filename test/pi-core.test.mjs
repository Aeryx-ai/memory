import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readSettings, contextBlock, compactionFromSummary, summarizeCmd, snapshotIsStale } from "../extensions/pi-core.mjs";
import { createConcept } from "../src/concept.mjs";
import { projectIdFor } from "../src/project-id.mjs";
import { tmpBundle, tmpDir } from "./helpers.mjs";
test("settings merge project over global", () => {
  const agent = tmpDir(), cwd = tmpDir();
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ memory: { summaryModel: "deepseek/deepseek-v4-flash", observeAfterTokens: 4000 } }));
  fs.mkdirSync(path.join(cwd, ".pi")); fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ memory: { observeAfterTokens: 6000 } }));
  assert.deepEqual(readSettings(agent, cwd), { summaryModel: "deepseek/deepseek-v4-flash", observeAfterTokens: 6000 });
});
test("context block wraps renderContext and names the tools", () => {
  const b = tmpBundle();
  const text = contextBlock(b, b.root, "pi:session/x");
  assert.match(text, /<memory-context/); assert.match(text, /memory_remember/);
});
test("context block passes a 200000 byte budget, so an oversized bundle gets truncated instead of injected whole", () => {
  const b = tmpBundle();
  const projectId = projectIdFor(b.root);
  const proj = b.dir(projectId);
  const bigBody = `# Reflections\n\n# Observations\n${"x".repeat(300000)}\n`;
  b.writeConcept(b.conceptRel(proj, "Session Summary", "huge"), createConcept({ type: "Session Summary", title: "huge", actor: "pi/m", at: "2026-08-29T00:00:00Z", sources: [{ resource: "pi:session/huge" }], body: bigBody }));
  const text = contextBlock(b, b.root, "pi:session/huge");
  assert.ok(Buffer.byteLength(text) < 205000, `expected the 200000 byte budget to truncate, got ${Buffer.byteLength(text)} bytes`);
});
test("compaction from summary uses the session's Session Summary or returns null", () => {
  const b = tmpBundle(); const dir = b.dir("local/x");
  assert.equal(compactionFromSummary(b, "local/x", "pi:session/s", { firstKeptEntryId: "k", tokensBefore: 100 }), null);
  b.writeConcept(b.conceptRel(dir, "Session Summary", "s"), createConcept({ type: "Session Summary", title: "s", actor: "pi/m", at: "2026-08-29T00:00:00Z", sources: [{ resource: "pi:session/s" }], body: "# Reflections\n[aaaaaaaaaaaa] fact\n\n# Observations\n" }));
  const r = compactionFromSummary(b, "local/x", "pi:session/s", { firstKeptEntryId: "k", tokensBefore: 100 });
  assert.equal(r.firstKeptEntryId, "k"); assert.match(r.summary, /fact/); assert.match(r.summary, /recall-observation|memory_recall_observation/);
});
test("summarize command prefers the configured model, keeps providers available, and isolates the nested extension", () => {
  const a = summarizeCmd({ summaryModel: "a/b" }, { provider: "x", id: "y" });
  assert.match(a, /--model a\/b/);
  assert.match(a, /^MEMORY=off pi -p /);
  assert.match(a, /--no-skills/);
  assert.doesNotMatch(a, /--no-extensions/);
  assert.match(summarizeCmd({}, { provider: "x", id: "y" }), /--model x\/y/);
});
test("snapshotIsStale compares local calendar dates, not a rolling window", () => {
  const beforeMidnight = new Date(2026, 7, 29, 23, 59); // Aug 29 2026 23:59 local
  const afterMidnight = new Date(2026, 7, 30, 0, 1); // Aug 30 2026 00:01 local
  assert.equal(snapshotIsStale(beforeMidnight, afterMidnight), true); // crossed midnight
  assert.equal(snapshotIsStale(beforeMidnight, beforeMidnight), false); // same instant
  const laterSameDay = new Date(2026, 7, 29, 23, 58);
  assert.equal(snapshotIsStale(beforeMidnight, laterSameDay), false); // still Aug 29, even though laterSameDay < beforeMidnight
});
