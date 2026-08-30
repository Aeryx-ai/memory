import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmpBundle, tmpGitRepo } from "./helpers.mjs";
const hooks = path.join(import.meta.dirname, "..", "claude-plugin", "hooks");
const bin = `node ${path.join(import.meta.dirname, "..", "bin", "memory.mjs")}`;
function run(script, input, env = {}) {
  return execFileSync("bash", [path.join(hooks, script)], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, MEMORY_BIN: bin, MEMORY_SYNC_INLINE: "1", ...env } });
}
test("hooks.json is valid and wires the four events", () => {
  const h = JSON.parse(fs.readFileSync(path.join(hooks, "hooks.json"), "utf8")).hooks;
  assert.deepEqual(Object.keys(h).sort(), ["PreCompact", "SessionEnd", "SessionStart", "Stop"]);
  assert.equal(h.Stop[0].hooks[0].async, true);
});
test("session-start emits additionalContext with the memory block", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const out = JSON.parse(run("session-start.sh", { session_id: "s1", cwd: repo, trigger: "startup" }, { MEMORY_DIR: b.root }));
  assert.match(out.hookSpecificOutput.additionalContext, /<memory-context .*project="github.com\/a\/b"/);
  assert.match(out.hookSpecificOutput.additionalContext, /memory remember --type/);
});
test("stop runs fold and exits 0 quickly; pre-compact emits instructions; session-end finalizes", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const transcript = path.join(import.meta.dirname, "fixtures", "transcripts", "claude.jsonl");
  const t0 = Date.now();
  run("stop.sh", { session_id: "f4b47d50", cwd: repo, transcript_path: transcript, stop_hook_active: false }, { MEMORY_DIR: b.root, MEMORY_SUMMARIZE_CMD: "cat >/dev/null; echo '[low] noop | 2a55d202-0256-4c6a-acb8-d2c40a35847f'" });
  assert.ok(Date.now() - t0 < 5000);
  const pc = JSON.parse(run("pre-compact.sh", { session_id: "f4b47d50", cwd: repo, trigger: "auto" }, { MEMORY_DIR: b.root }));
  assert.match(pc.hookSpecificOutput.compactionInstructions, /running session summary/i);
  run("session-end.sh", { session_id: "f4b47d50", cwd: repo, transcript_path: transcript, trigger: "other" }, { MEMORY_DIR: b.root, MEMORY_SUMMARIZE_CMD: "cat >/dev/null; echo '[low] noop | 2a55d202-0256-4c6a-acb8-d2c40a35847f'" });
  const sums = b.listConcepts(b.dir("github.com/a/b")).filter((e) => e.concept.type === "Session Summary");
  assert.equal(sums.length, 1); assert.equal(sums[0].concept.status, "stable");
});
