// The detached spawn path (spawnDetached in src/git.mjs) has no coverage
// anywhere else: every other test sets MEMORY_SYNC_INLINE=1 so the write-
// completion job (index, commit, push) and fold's observer/reflector job
// run inline, in-process, for determinism and speed. This file is the one
// place that runs the real CLI as a real child process, without that
// switch, and proves the actual background jobs land.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmpBundle, tmpGitRepo } from "./helpers.mjs";
import { parseSummaryBody } from "../src/summary.mjs";

const bin = path.join(import.meta.dirname, "..", "bin", "memory.mjs");
const fx = path.join(import.meta.dirname, "fixtures", "transcripts", "pi.jsonl");

// Explicit, not just "don't set it": guards this file against picking up
// MEMORY_SYNC_INLINE from the environment even if node --test's default
// per-file process isolation ever changed.
function detachedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.MEMORY_SYNC_INLINE;
  return env;
}

async function pollUntil(check, { timeoutMs, intervalMs = 200, what }) {
  const start = Date.now();
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; the environment may not support detached child processes (spawn+unref)`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("remember returns fast; its detached job commits to the bundle's git log in the background", async () => {
  const b = tmpBundle();
  const repo = tmpGitRepo("git@github.com:a/b.git");
  const args = [bin, "--dir", b.root, "--cwd", repo, "--actor", "human:test", "remember", "--type", "Feedback", "--title", "Detached Write"];
  const t0 = Date.now();
  const out = execFileSync(process.execPath, args, { input: "Body written by the detached-spawn test.\n", encoding: "utf8", env: detachedEnv() });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `remember took ${elapsed}ms, expected under 2000ms (the write itself must never wait on the background job)`);
  assert.equal(JSON.parse(out).created, true);

  await pollUntil(() => {
    let log;
    // stdio ignores stderr deliberately: "no commits yet" is the expected
    // shape of every poll attempt before the detached job's first commit.
    try { log = execFileSync("git", ["log", "--oneline"], { cwd: b.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return false; } // no commits yet
    return /memory: remember/.test(log) || null;
  }, { timeoutMs: 15000, what: "the detached job's commit to appear in `git log`" });
});

test("fold with a slow summarizer returns spawned in under 500ms; the detached job folds an observation into the Session Summary", async () => {
  const b = tmpBundle();
  const repo = tmpGitRepo("git@github.com:a/b.git");
  // Sleeps 2s before answering, so this can only pass if fold() truly
  // detaches instead of waiting on the summarizer child.
  const slowSummarizer = `sh -c 'sleep 2; echo "[high] User requires pnpm, never npm | a1b2c3d4"'`;
  const args = [
    bin, "--dir", b.root, "--cwd", repo, "--actor", "pi/kimi-k3",
    "fold", "--session", "pi:session/detached", "--transcript", fx, "--format", "pi",
    "--summarize-cmd", slowSummarizer, "--observeAfterTokens", "1",
  ];
  const t0 = Date.now();
  const out = execFileSync(process.execPath, args, { input: "", encoding: "utf8", env: detachedEnv() });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `fold took ${elapsed}ms, expected under 500ms (it must spawn and return, not wait on the summarizer)`);
  assert.deepEqual(JSON.parse(out), { status: "spawned" });

  await pollUntil(() => {
    const dir = b.dir("github.com/a/b");
    const summaries = b.listConcepts(dir).filter((e) => e.concept.type === "Session Summary");
    if (!summaries.length) return false;
    const body = parseSummaryBody(summaries[0].concept.body);
    return body.observations.length > 0 || null;
  }, { timeoutMs: 15000, what: "the detached fold job to append an observation to the Session Summary" });
});
