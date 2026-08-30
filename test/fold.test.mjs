import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fold, runFoldJob } from "../src/fold.mjs";
import { parseSummaryBody } from "../src/summary.mjs";
import { tmpBundle, tmpGitRepo } from "./helpers.mjs";
process.env.MEMORY_SYNC_INLINE = "1";
const fx = path.join(import.meta.dirname, "fixtures", "transcripts", "pi.jsonl");
const observer = `sh -c 'grep -q "You distill" - && echo "Keep pnpm <- $(cat "$MEMORY_PROMPT_FILE" | grep -o "\\[[a-f0-9]\\{12\\}\\]" | head -1 | tr -d "[]")" || echo "[high] User requires pnpm, never npm | a1b2c3d4"'`;
test("fold skips under threshold, folds when forced, appends observations with sources, finalize stabilizes", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const opts = { session: "pi:session/01a0457b", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: observer, settings: { observeAfterTokens: 8000, reflectAfterTokens: 20000, observationsMaxTokens: 20000, observationsTargetTokens: 10000 } };
  assert.equal(fold(b, opts).status, "skipped");
  const r = runFoldJob(b, { ...opts, force: true });
  assert.equal(r.observations, 1);
  const dir = b.dir("github.com/a/b");
  const [{ rel, concept }] = b.listConcepts(dir).filter((e) => e.concept.type === "Session Summary");
  assert.match(rel, /session-summaries\/\d{8}T\d{6}Z-pi-kimi-k3\.md$/);
  assert.equal(concept.status, "draft");
  const body = parseSummaryBody(concept.body);
  assert.equal(body.observations[0].content, "User requires pnpm, never npm"); assert.equal(body.observations[0].relevance, "high");
  assert.ok(concept.sources.some((s) => s.id === body.observations[0].id && s.resource === "a1b2c3d4"));
  const state = JSON.parse(fs.readFileSync(b.statePath("pi-session-01a0457b.json"), "utf8"));
  assert.equal(state.transcriptBytes, fs.statSync(fx).size);
  assert.equal(state.rel, rel); // persisted immediately on concept creation, not only at the end of the job
  assert.equal(fold(b, opts).status, "skipped");
  assert.equal(runFoldJob(b, { ...opts, force: true }).observations, 0);
  runFoldJob(b, { ...opts, finalize: true });
  assert.equal(b.readConcept(rel).status, "stable");
});
test("reflector runs when observed tokens cross the threshold", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const opts = { session: "pi:session/r", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: observer, force: true, settings: { observeAfterTokens: 1, reflectAfterTokens: 1, observationsMaxTokens: 20000, observationsTargetTokens: 10000 } };
  const r = runFoldJob(b, opts);
  assert.equal(r.reflected, true);
  const [{ concept }] = b.listConcepts(b.dir("github.com/a/b"));
  const body = parseSummaryBody(concept.body);
  assert.equal(body.reflections.length, 1); assert.deepEqual(body.reflections[0].supports, [body.observations[0].id]);
});
test("two observations citing the same entry id do not collide on source dedup", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const dup = `sh -c 'echo "[high] First observation | a1b2c3d4"; echo "[medium] Second observation | a1b2c3d4"'`;
  const opts = { session: "pi:session/dup", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: dup };
  const r = runFoldJob(b, opts);
  assert.equal(r.observations, 2);
  const [{ concept }] = b.listConcepts(b.dir("github.com/a/b")).filter((e) => e.concept.type === "Session Summary");
  const body = parseSummaryBody(concept.body);
  assert.equal(body.observations.length, 2);
  assert.deepEqual(concept.sources.filter((s) => s.resource === "a1b2c3d4").map((s) => s.id).sort(),
    body.observations.map((o) => o.id).sort());
});
test("an observation containing a secret is dropped before it reaches the concept; checkpoint still advances without throwing", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const leaky = `sh -c 'echo "[high] Key is AKIAIOSFODNN7EXAMPLE | a1b2c3d4"'`;
  const opts = { session: "pi:session/leak", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: leaky };
  const r = runFoldJob(b, opts);
  assert.equal(r.observations, 0);
  assert.equal(r.error, undefined);
  const [{ concept }] = b.listConcepts(b.dir("github.com/a/b")).filter((e) => e.concept.type === "Session Summary");
  const body = parseSummaryBody(concept.body);
  assert.ok(!body.observations.some((o) => /AKIA/.test(o.content)));
  const state = JSON.parse(fs.readFileSync(b.statePath("pi-session-leak.json"), "utf8"));
  assert.equal(state.transcriptBytes, fs.statSync(fx).size);
});
test("fold's own byte gate is enough in production: the child no longer re-gates on serialized tokens", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const opts = { session: "pi:session/prod", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: observer, settings: { observeAfterTokens: 1, reflectAfterTokens: 20000, observationsMaxTokens: 20000, observationsTargetTokens: 10000 } };
  const r = fold(b, opts);
  assert.equal(r.status, "folded");
  assert.equal(r.observations, 1);
});
test("fold surfaces an inline skip (no summarizer configured) as status skipped, not folded", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const opts = { session: "pi:session/nosumm", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", settings: { observeAfterTokens: 1 } };
  const r = fold(b, opts);
  assert.equal(r.status, "skipped");
  assert.equal(r.reason, "no summarizer");
  assert.equal(b.listConcepts(b.dir("github.com/a/b")).length, 0); // no orphan concept created
});
test("runFoldJob with finalize and a missing transcript is a no-op skip", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const missing = path.join(repo, "nope.jsonl");
  const r = runFoldJob(b, { session: "pi:session/missing", actor: "pi/kimi-k3", transcript: missing, cwd: repo, format: "pi", summarizeCmd: observer, finalize: true });
  assert.deepEqual(r, { observations: 0, reflected: false, dropped: 0, skipped: "no transcript" });
  assert.equal(b.listConcepts(b.dir("github.com/a/b")).length, 0);
});
test("the fold lock's stale window is sized to a fold's worst case (two 180s summarizer calls), not the git lock's 300s", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const opts = { session: "pi:session/lock", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: observer };
  const lock = path.join(b.root, ".locks", "fold-pi-session-lock");
  fs.mkdirSync(lock, { recursive: true });
  const aged400 = new Date(Date.now() - 400_000); fs.utimesSync(lock, aged400, aged400);
  assert.equal(runFoldJob(b, opts).skipped, "locked"); // 400s old: still inside the fold's 900s window, not stale
  const aged1000 = new Date(Date.now() - 1_000_000); fs.utimesSync(lock, aged1000, aged1000);
  assert.equal(runFoldJob(b, opts).observations, 1); // 1000s old: past the fold's 900s window, reclaimed
  fs.mkdirSync(lock, { recursive: true }); // fresh (live) lock this time
  assert.equal(runFoldJob(b, opts).skipped, "locked");
  fs.rmSync(lock, { recursive: true, force: true });
});
test("a reflection whose supports get pruned away is kept with empty supports, not dropped", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const weird = `sh -c 'grep -q "You distill" - && echo "Stable fact <- 000000000000" || echo "[high] User requires pnpm, never npm | a1b2c3d4"'`;
  const opts = { session: "pi:session/orphan-ref", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: weird, settings: { observeAfterTokens: 1, reflectAfterTokens: 1, observationsMaxTokens: 20000, observationsTargetTokens: 10000 } };
  const r = runFoldJob(b, opts);
  assert.equal(r.reflected, true);
  const [{ concept }] = b.listConcepts(b.dir("github.com/a/b"));
  const body = parseSummaryBody(concept.body);
  assert.equal(body.reflections.length, 1);
  assert.deepEqual(body.reflections[0].supports, []);
  assert.equal(body.reflections[0].content, "Stable fact");
});
test("finalize with no summarizer and nothing folded yet returns no summarizer; creates no concept", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const r = runFoldJob(b, { session: "pi:session/bare-finalize", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", finalize: true });
  assert.deepEqual(r, { observations: 0, reflected: false, dropped: 0, skipped: "no summarizer" });
  assert.equal(b.listConcepts(b.dir("github.com/a/b")).length, 0);
});
test("finalize with no summarizer promotes an already-drafted summary to stable, skips the observer, and never advances the checkpoint", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const opts = { session: "pi:session/promote", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: observer };
  const first = runFoldJob(b, opts);
  assert.equal(first.observations, 1);
  const dir = b.dir("github.com/a/b");
  const [{ rel }] = b.listConcepts(dir).filter((e) => e.concept.type === "Session Summary");
  assert.equal(b.readConcept(rel).status, "draft");
  const before = JSON.parse(fs.readFileSync(b.statePath("pi-session-promote.json"), "utf8"));
  // Note: transcript now points at a path that does not exist, and summarizeCmd
  // is absent; promotion must not need either.
  const missing = path.join(repo, "gone.jsonl");
  const r2 = runFoldJob(b, { session: opts.session, actor: opts.actor, transcript: missing, cwd: repo, format: "pi", finalize: true });
  assert.deepEqual(r2, { observations: 0, reflected: false, dropped: 0 });
  assert.equal(b.readConcept(rel).status, "stable");
  const after = JSON.parse(fs.readFileSync(b.statePath("pi-session-promote.json"), "utf8"));
  assert.equal(after.transcriptBytes, before.transcriptBytes); // checkpoint untouched
});
