import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConcept, revise } from "./concept.mjs";
import { projectIdFor } from "./project-id.mjs";
import { appendLog } from "./log-file.mjs";
import { afterWrite } from "./jobs.mjs";
import { spawnDetached, withLock } from "./git.mjs";
import { readDelta, detectFormat, serializeEntries } from "./transcript.mjs";
import { parseSummaryBody, renderSummaryBody, pruneObservations, newId, estimateTokens, RELEVANCE, isSessionSummaryFor } from "./summary.mjs";
import { findSecret } from "./secrets.mjs";
import { slugify } from "./slug.mjs";

export const DEFAULTS = { observeAfterTokens: 8000, reflectAfterTokens: 20000, observationsMaxTokens: 20000, observationsTargetTokens: 10000, observerMaxTokens: 60000 };
// The pi extension derives its allowed --settings keys from this list, so a
// new fold setting can't be silently dropped by a stale hardcoded list.
export const FOLD_SETTING_KEYS = Object.keys(DEFAULTS);
// Prompt-injection bounds (see the spec's Trust boundary paragraph): an
// observation line is capped so one steered line can't smuggle an
// unbounded amount of text into every later session's context, and a
// single fold can add only so many observations regardless of how long
// the summarizer's output runs.
const OBSERVATION_MAX_CHARS = 240;
const MAX_OBSERVATIONS_PER_FOLD = 40;
const GIVE_UP_AFTER_FAILURES = 3;
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "memory.mjs");
const sessionSlug = (s) => s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

export function OBSERVER_PROMPT(reflections, recent, delta) {
  return `You extract observations from a coding-agent transcript delta. Output only lines of the form:
[relevance] one-line observation | entryId,entryId
relevance is one of ${RELEVANCE.join(", ")}. Record decisions, constraints, preferences, completed work, rejected approaches, open items. Skip chatter. Cite the transcript entry ids the observation came from.

Existing reflections:
${reflections.map((r) => `[${r.id}] ${r.content}`).join("\n") || "(none)"}

Recent observations:
${recent.map((o) => `[${o.id}] ${o.at} [${o.relevance}] ${o.content}`).join("\n") || "(none)"}

Transcript delta:
${delta}`;
}
export function REFLECTOR_PROMPT(reflections, observations) {
  return `You distill durable reflections from observations. Output only lines of the form:
one-line durable fact <- obsId,obsId
A reflection is a stable fact about the user, project, decision or constraint. Cite every observation whose durable meaning it preserves, and only those.

Current reflections:
${reflections.map((r) => `[${r.id}] ${r.content} <- ${r.supports.join(",")}`).join("\n") || "(none)"}

Observations:
${observations.map((o) => `[${o.id}] ${o.at} [${o.relevance}] ${o.content}`).join("\n")}`;
}

function statePath(bundle, session) { return bundle.statePath(`${sessionSlug(session)}.json`); }
function loadState(bundle, session) { try { return JSON.parse(fs.readFileSync(statePath(bundle, session), "utf8")); } catch { return { session, transcriptBytes: 0, foldedAt: null, rel: null, observedSinceReflect: 0 }; } }
function saveState(bundle, state) { fs.writeFileSync(statePath(bundle, state.session), JSON.stringify(state)); }

// Called from the CLI's _fold wrapper when runFoldJob throws unexpectedly, so a
// detached job always leaves a trail instead of silently vanishing.
export function markFoldError(bundle, session, message) {
  const state = loadState(bundle, session);
  state.lastError = { at: new Date().toISOString(), message };
  saveState(bundle, state);
}

// "YYYY-MM-DD HH:MM" in UTC, regardless of the machine's local timezone: the
// bare form an observation's `at` field uses (matches summary.mjs's OBS
// regex), and the Session Summary title's "<...> UTC" form built on top of it.
function utcMinuteRaw(iso) { return iso.slice(0, 16).replace("T", " "); }
export function utcMinute(iso) { return `${utcMinuteRaw(iso)} UTC`; }
export function sessionSummaryRel(bundle, dir, at, actor) {
  const stamp = at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return bundle.conceptRel(dir, "Session Summary", `${stamp}-${slugify(actor)}`);
}

export function fold(bundle, opts) {
  const { session, transcript, finalize = false } = opts;
  const state = loadState(bundle, session);
  const size = fs.existsSync(transcript) ? fs.statSync(transcript).size : 0;
  if (size < state.transcriptBytes) state.transcriptBytes = 0;
  const settings = { ...DEFAULTS, ...(opts.settings ?? {}) };
  const pending = Math.ceil(Math.max(0, size - state.transcriptBytes) / 4);
  if (!finalize && pending < settings.observeAfterTokens) return { status: "skipped", reason: `${pending} tokens pending` };
  if (process.env.MEMORY_SYNC_INLINE === "1") {
    const r = runFoldJob(bundle, opts);
    return r.skipped ? { status: "skipped", reason: r.skipped } : { status: "folded", ...r };
  }
  const args = [BIN, "_fold", "--dir", bundle.root, "--session", session, "--transcript", transcript, "--actor", opts.actor, "--cwd", opts.cwd];
  if (opts.format) args.push("--format", opts.format);
  if (finalize) args.push("--finalize");
  if (opts.summarizeCmd) args.push("--summarize-cmd", opts.summarizeCmd);
  for (const [k, v] of Object.entries(opts.settings ?? {})) args.push(`--${k}`, String(v));
  spawnDetached(args);
  return { status: "spawned" };
}

function runSummarizer(cmd, prompt) {
  const file = path.join(os.tmpdir(), `memory-prompt-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, prompt, { mode: 0o600 });
  try { return execSync(cmd, { input: prompt, encoding: "utf8", env: { ...process.env, MEMORY_PROMPT_FILE: file }, timeout: 180_000, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] }); }
  finally { fs.rmSync(file, { force: true }); }
}
const OBS_OUT = /^\[(low|medium|high|critical)\]\s+(.+?)\s*\|\s*([A-Za-z0-9,_-]+)\s*$/;
const REF_OUT = /^(.+?)\s*<-\s*([a-f0-9]{12}(?:,[a-f0-9]{12})*)\s*$/;
// Drop the oldest entries until the serialized delta fits observerMaxTokens,
// so one long-idle session catching up in a single fold can't blow the
// observer prompt up without bound. Keeps at least one entry.
// One pass: each entry's serialized byte length is computed once, then
// entries are walked newest-to-oldest accumulating bytes, stopping (and
// dropping everything older) the moment the running total would exceed
// maxTokens. Re-serializing the whole remaining delta on every drop is O(n^2)
// and unusable past a few thousand entries; this is O(n).
export function capDelta(entries, maxTokens) {
  const n = entries.length;
  if (n === 0) return entries;
  let bytes = Buffer.byteLength(serializeEntries([entries[n - 1]]));
  let start = n - 1;
  for (let i = n - 2; i >= 0; i--) {
    const next = bytes + Buffer.byteLength(serializeEntries([entries[i]]));
    if (Math.ceil(next / 4) > maxTokens) break;
    bytes = next;
    start = i;
  }
  return entries.slice(start);
}
function truncateObservation(content) {
  return content.length > OBSERVATION_MAX_CHARS ? `${content.slice(0, OBSERVATION_MAX_CHARS)}…` : content;
}

export function runFoldJob(bundle, opts) {
  const { session, transcript, finalize = false } = opts;
  const hasSummarizer = !!opts.summarizeCmd;
  // With no summarizer there's nothing to observe or reflect on; the only
  // useful work left is promoting an already-drafted summary on finalize,
  // handled inside the lock below (it needs to see whether a concept exists).
  if (!hasSummarizer && !finalize) return { observations: 0, reflected: false, dropped: 0, skipped: "no summarizer" };
  // The promote-only path never reads the transcript, so only require it when
  // a summarizer is actually going to run over it.
  if (hasSummarizer && !fs.existsSync(transcript)) return { observations: 0, reflected: false, dropped: 0, skipped: "no transcript" };
  let result = { observations: 0, reflected: false, dropped: 0 };
  // staleMs is generous: a fold can run two summarizer calls (observer, then
  // reflector) back to back, each with its own 180s timeout, so the default
  // git-lock staleness window (300s) is shorter than a fold's worst case and
  // would let a second fold reclaim a still-live lock.
  const ran = withLock(bundle.root, () => { result = runFold(bundle, opts); }, { name: `fold-${sessionSlug(session)}`, staleMs: 900_000 });
  if (!ran) return { observations: 0, reflected: false, dropped: 0, skipped: "locked" };
  return result;
}

function promoteToStable(bundle, dir, state, rel, concept, actor, now, session) {
  let revised;
  try {
    revised = revise(concept, { status: "stable" }, actor, now);
  } catch (e) {
    state.lastError = { at: now, message: e.message };
    saveState(bundle, state);
    return { observations: 0, reflected: false, dropped: 0, error: e.message };
  }
  bundle.writeConcept(rel, revised);
  appendLog(bundle, dir, { kind: "Update", concept: revised, rel, actor, at: now });
  afterWrite(bundle, { dirRel: dir.rel, message: `memory: fold ${session}` });
  // No summarizer runs on this path, so a prior give-up marker (lastError,
  // failures) is left as is: promoting a draft is not a successful fold of
  // the abandoned delta, and transcriptBytes/foldedAt stay untouched too, so
  // there's nothing new to persist here.
  return { observations: 0, reflected: false, dropped: 0 };
}

// A summarizer that keeps throwing must not let the delta grow forever: on
// the first two consecutive failures just record why and leave the
// checkpoint where it is (the same delta is retried next fold). On the
// third, give up on this delta specifically: advance transcriptBytes past it
// so it stops growing, and note that it was abandoned. failures is left at
// its count (not reset) so doctor's failures >= 3 check reflects real state
// and a later no-op fold can't read as healthy; only a fold that actually
// sends entries to the summarizer and succeeds clears it (see the bottom of
// runFold).
function giveUpOrRetry(bundle, state, rel, error, bytes, now) {
  state.failures = (state.failures ?? 0) + 1;
  if (state.failures >= GIVE_UP_AFTER_FAILURES) {
    state.lastError = { at: now, message: `${error.message} (delta abandoned after ${GIVE_UP_AFTER_FAILURES} consecutive summarizer failures)` };
    Object.assign(state, { rel, transcriptBytes: bytes, foldedAt: now });
  } else {
    state.lastError = { at: now, message: error.message };
  }
  saveState(bundle, state);
  return { observations: 0, reflected: false, dropped: 0, error: state.lastError.message };
}

function runFold(bundle, opts) {
  const { session, actor, cwd, finalize = false, summarizeCmd } = opts;
  const state = loadState(bundle, session);
  const dir = bundle.dir(opts.projectId ?? projectIdFor(cwd));
  const now = new Date().toISOString();
  let rel = state.rel, concept;
  if (rel) { try { concept = bundle.readConcept(rel); } catch { rel = null; } }
  if (!rel) {
    // The checkpoint's rel can go missing (state lost, or the session resumed
    // on another machine with a fresh checkpoint): recover the existing
    // Session Summary for this session rather than creating a second one.
    const existing = bundle.listConcepts(dir).find((e) => isSessionSummaryFor(e.concept, session));
    if (existing) { rel = existing.rel; concept = existing.concept; }
  }

  if (!summarizeCmd) {
    // finalize:true with no summarizer configured: promote whatever draft
    // already exists, skip the observer entirely, never create a concept and
    // never touch the checkpoint.
    if (!rel) return { observations: 0, reflected: false, dropped: 0, skipped: "no summarizer" };
    return promoteToStable(bundle, dir, state, rel, concept, actor, now, session);
  }

  const { transcript } = opts;
  const settings = { ...DEFAULTS, ...(opts.settings ?? {}) };
  const format = opts.format ?? detectFormat(transcript);
  if (!rel) {
    rel = sessionSummaryRel(bundle, dir, now, actor);
    concept = createConcept({ type: "Session Summary", title: `${utcMinute(now)} ${actor}`, description: `Session ${session}`, status: "draft", actor, at: now, sources: [{ resource: session }, { resource: transcript, title: "transcript" }], body: renderSummaryBody({ reflections: [], observations: [] }) });
    bundle.writeConcept(rel, concept);
    appendLog(bundle, dir, { kind: "Creation", concept, rel, actor, at: now });
  }
  // Persist the concept's rel before any model call: if the summarizer hangs or
  // the process dies mid-job, the next fold finds this draft instead of
  // creating an orphan.
  state.rel = rel;
  saveState(bundle, state);

  const { entries, bytes } = readDelta(transcript, format, state.transcriptBytes);
  const body = parseSummaryBody(concept.body);
  const added = [], sources = [];
  if (entries.length) {
    const capped = capDelta(entries, settings.observerMaxTokens);
    let out;
    try {
      out = runSummarizer(summarizeCmd, OBSERVER_PROMPT(body.reflections, body.observations.slice(-20), serializeEntries(capped)));
    } catch (e) {
      return giveUpOrRetry(bundle, state, rel, e, bytes, now);
    }
    const byId = new Map(capped.map((e) => [e.id, e]));
    // At most MAX_OBSERVATIONS_PER_FOLD observations per fold, regardless of
    // how many lines the summarizer returns.
    for (const line of out.split("\n").slice(0, MAX_OBSERVATIONS_PER_FOLD)) {
      const m = OBS_OUT.exec(line.trim()); if (!m) continue;
      const ids = m[3].split(",").filter((id) => byId.has(id)); if (!ids.length) continue;
      const content = truncateObservation(m[2]);
      if (findSecret(content)) continue; // never persist a secret into the concept
      const id = newId();
      added.push({ id, at: utcMinuteRaw(byId.get(ids[0]).at ?? now), relevance: m[1], content });
      sources.push({ resource: ids.join(","), id });
    }
  }
  body.observations.push(...added);
  state.observedSinceReflect = (state.observedSinceReflect ?? 0) + estimateTokens(added.map((o) => o.content).join("\n"));
  let reflected = false;
  if (body.observations.length && state.observedSinceReflect >= settings.reflectAfterTokens) {
    try {
      const out = runSummarizer(summarizeCmd, REFLECTOR_PROMPT(body.reflections, body.observations));
      const known = new Set(body.observations.map((o) => o.id));
      const next = [];
      for (const line of out.split("\n")) {
        const m = REF_OUT.exec(line.trim()); if (!m) continue;
        const content = m[1].trim(); if (!content) continue;
        if (findSecret(content)) continue; // never persist a secret into a reflection either
        // Supports that no longer exist (pruned away) don't invalidate the
        // reflection itself; keep it with whatever supports still resolve.
        const supports = m[2].split(",").filter((id) => known.has(id));
        next.push({ id: newId(), content, supports });
      }
      if (next.length) { body.reflections = next; reflected = true; }
    } catch (e) {
      // The reflector is a bonus pass over already-collected observations; a
      // failure here must not wedge the checkpoint the way an observer
      // failure would, so it's logged and swallowed, not counted against
      // the give-up streak.
      state.lastError = { at: now, message: `reflector: ${e.message}` };
    }
    // The reflector ran either way; don't let a garbled response (or a failed
    // call) re-trigger it on the same backlog forever.
    state.observedSinceReflect = 0;
  }
  // Pin sources whose id a surviving reflection still cites via supports, so
  // pruning the observation it was drawn from doesn't strand
  // recall-observation on that reflection with no source to resolve.
  const pinned = new Set(body.reflections.flatMap((r) => r.supports));
  const pruned = pruneObservations({ observations: body.observations, reflections: body.reflections, maxTokens: settings.observationsMaxTokens, targetTokens: settings.observationsTargetTokens });
  body.observations = pruned.observations;
  const dropped = new Set(pruned.dropped);
  const keptSources = concept.sources.filter((s) => !s.id || pinned.has(s.id) || !dropped.has(s.id));

  let revised;
  try {
    revised = revise({ ...concept, sources: keptSources }, { body: renderSummaryBody(body), sources, ...(finalize ? { status: "stable" } : {}) }, actor, now);
  } catch (e) {
    // A refused revise (e.g. a secret that slipped past the observation filter)
    // must not wedge the session: abandon this delta, don't retry it forever.
    state.lastError = { at: now, message: e.message };
    Object.assign(state, { rel, transcriptBytes: bytes, foldedAt: now });
    saveState(bundle, state);
    return { observations: 0, reflected: false, dropped: 0, error: e.message };
  }
  concept = revised;
  bundle.writeConcept(rel, concept);
  appendLog(bundle, dir, { kind: "Update", concept, rel, actor, at: now });
  afterWrite(bundle, { dirRel: dir.rel, message: `memory: fold ${session}` });
  // Only a fold that actually sent entries to the summarizer and got this far
  // (revise succeeded) counts as a real success: clear any give-up marker
  // then. A zero-entries fold (nothing pending) must leave lastError/failures
  // exactly as they were, or a dead summarizer's give-up state would get
  // silently erased by the next fold that happens to find nothing new to do.
  if (entries.length) { delete state.lastError; state.failures = 0; }
  Object.assign(state, { rel, transcriptBytes: bytes, foldedAt: now });
  saveState(bundle, state);
  return { observations: added.length, reflected, dropped: pruned.dropped.length };
}
