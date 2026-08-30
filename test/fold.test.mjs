import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fold, runFoldJob } from "../src/fold.mjs";
import { parseSummaryBody } from "../src/summary.mjs";
import { tmpBundle, tmpGitRepo, tmpDir } from "./helpers.mjs";
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
test("a persistently failing summarizer gives up after three consecutive failures, advancing the checkpoint past the abandoned delta", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const opts = { session: "pi:session/give-up", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: "false" };
  let r;
  for (let i = 0; i < 3; i++) r = runFoldJob(b, opts);
  assert.match(r.error, /abandoned/);
  const state = JSON.parse(fs.readFileSync(b.statePath("pi-session-give-up.json"), "utf8"));
  assert.equal(state.failures, 0); // streak reset after giving up
  assert.match(state.lastError.message, /abandoned/);
  assert.ok(state.transcriptBytes > 0); // checkpoint advanced past the abandoned delta
  // the abandoned delta is not retried: a working summarizer now sees nothing new
  const after = runFoldJob(b, { ...opts, summarizeCmd: observer });
  assert.equal(after.observations, 0);
});
test("a summarizer that fails once then recovers does not abandon the delta, and success resets the failure streak", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const failing = { session: "pi:session/retry", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: "false" };
  runFoldJob(b, failing);
  let state = JSON.parse(fs.readFileSync(b.statePath("pi-session-retry.json"), "utf8"));
  assert.equal(state.failures, 1);
  assert.equal(state.transcriptBytes, 0); // not abandoned yet, only one strike
  const r = runFoldJob(b, { ...failing, summarizeCmd: observer });
  assert.equal(r.observations, 1);
  state = JSON.parse(fs.readFileSync(b.statePath("pi-session-retry.json"), "utf8"));
  assert.equal(state.failures, 0);
  assert.equal(state.lastError, undefined);
});
test("the observer's delta is capped to observerMaxTokens by dropping the oldest entries first", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const dir = tmpDir();
  const transcript = path.join(dir, "big.jsonl");
  const lines = [JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-08-27T23:08:45.256Z", cwd: "/tmp/x" })];
  for (let i = 0; i < 10; i++) {
    lines.push(JSON.stringify({
      type: "message", id: `e${String(i).padStart(2, "0")}`, parentId: null,
      timestamp: `2026-08-27T23:09:${String(i).padStart(2, "0")}.000Z`,
      message: { role: "user", content: [{ type: "text", text: "x".repeat(80) }] },
    }));
  }
  fs.writeFileSync(transcript, lines.join("\n") + "\n");
  const script = path.join(dir, "observe.mjs");
  fs.writeFileSync(script, [
    "import fs from \"node:fs\";",
    "const text = fs.readFileSync(process.env.MEMORY_PROMPT_FILE, \"utf8\");",
    "const ids = [...text.matchAll(/^--- (\\S+) /gm)].map((m) => m[1]);",
    "process.stdout.write(`[high] kept ${ids.length} | ${ids.join(\",\")}\\n`);",
  ].join("\n"));
  const opts = { session: "pi:session/cap", actor: "pi/kimi-k3", transcript, cwd: repo, format: "pi", summarizeCmd: `${process.execPath} ${script}`, settings: { observerMaxTokens: 70 } };
  const r = runFoldJob(b, opts);
  assert.equal(r.observations, 1);
  const [{ concept }] = b.listConcepts(b.dir("github.com/a/b"));
  const body = parseSummaryBody(concept.body);
  assert.match(body.observations[0].content, /^kept \d+$/);
  const keptCount = Number(body.observations[0].content.match(/\d+/)[0]);
  assert.ok(keptCount > 0 && keptCount < 10, `expected a partial cap, kept ${keptCount} of 10`);
  const source = concept.sources.find((s) => s.id === body.observations[0].id);
  const keptIds = source.resource.split(",");
  assert.equal(keptIds.length, keptCount);
  assert.ok(!keptIds.includes("e00")); // oldest dropped first
  assert.ok(keptIds.includes("e09")); // most recent kept
});
test("pruning a reflection's covered observation still leaves its cited source resolvable (finding 3: sources must not strand a surviving reflection)", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const opts = {
    session: "pi:session/prune-pin", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: observer,
    settings: { observeAfterTokens: 1, reflectAfterTokens: 1, observationsMaxTokens: 1, observationsTargetTokens: 0 },
  };
  const r = runFoldJob(b, opts);
  assert.equal(r.reflected, true);
  const [{ concept }] = b.listConcepts(b.dir("github.com/a/b"));
  const body = parseSummaryBody(concept.body);
  assert.equal(body.observations.length, 0); // the covered observation was pruned out of the body
  assert.equal(body.reflections.length, 1);
  const [supportId] = body.reflections[0].supports;
  assert.ok(supportId);
  const source = concept.sources.find((s) => s.id === supportId);
  assert.ok(source, "the pinned source for the reflection's support must survive pruning");
  assert.equal(source.resource, "a1b2c3d4");
});
test("checkpoint state lost mid-session: fold again recovers the existing Session Summary instead of creating a second one", () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const opts = { session: "pi:session/lost-state", actor: "pi/kimi-k3", transcript: fx, cwd: repo, format: "pi", summarizeCmd: observer };
  const first = runFoldJob(b, opts);
  assert.equal(first.observations, 1);
  fs.rmSync(b.statePath("pi-session-lost-state.json"), { force: true });
  const second = runFoldJob(b, opts);
  assert.equal(second.observations, 1);
  const dir = b.dir("github.com/a/b");
  const summaries = b.listConcepts(dir).filter((e) => e.concept.type === "Session Summary");
  assert.equal(summaries.length, 1);
});
