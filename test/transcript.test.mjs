import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readDelta, detectFormat, serializeEntries } from "../src/transcript.mjs";
import { tmpDir } from "./helpers.mjs";
const fx = (n) => path.join(import.meta.dirname, "fixtures", "transcripts", n);
test("pi delta: ids, roles, text without thinking, tool calls and results", () => {
  const { entries, bytes } = readDelta(fx("pi.jsonl"), "pi", 0);
  assert.equal(bytes, fs.statSync(fx("pi.jsonl")).size);
  assert.deepEqual(entries.map((e) => [e.id, e.role]), [["a1b2c3d4", "user"], ["b2c3d4e5", "assistant"], ["c3d4e5f6", "toolResult"]]);
  assert.equal(entries[1].text, 'Noted.\ncall bash({"command":"pnpm -v"})');
  assert.doesNotMatch(serializeEntries(entries), /secret thoughts/);
  assert.match(serializeEntries(entries), /^--- a1b2c3d4 user 2026-08-27T23:09:00.000Z\nuse pnpm here, never npm\n/);
});
test("claude delta and format detection", () => {
  assert.equal(detectFormat(fx("claude.jsonl")), "claude"); assert.equal(detectFormat(fx("pi.jsonl")), "pi");
  const { entries } = readDelta(fx("claude.jsonl"), "claude", 0);
  assert.deepEqual(entries.map((e) => e.role), ["user", "assistant", "toolResult"]);
  assert.equal(entries[2].text, "result: 9.0.0");
});
test("delta from an offset and a partial trailing line", () => {
  const p = path.join(tmpDir(), "partial.jsonl");
  const full = fs.readFileSync(fx("pi.jsonl"), "utf8");
  fs.writeFileSync(p, full.slice(0, -10));
  const first = readDelta(p, "pi", 0);
  assert.equal(first.entries.length, 2);
  assert.ok(first.bytes < fs.statSync(p).size);
  fs.writeFileSync(p, full);
  const second = readDelta(p, "pi", first.bytes);
  assert.equal(second.entries.length, 1); assert.equal(second.bytes, Buffer.byteLength(full));
});
