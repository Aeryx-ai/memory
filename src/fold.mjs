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
import { parseSummaryBody, renderSummaryBody, pruneObservations, newId, estimateTokens, RELEVANCE } from "./summary.mjs";
import { findSecret } from "./secrets.mjs";
import { slugify } from "./slug.mjs";

export const DEFAULTS = { observeAfterTokens: 8000, reflectAfterTokens: 20000, observationsMaxTokens: 20000, observationsTargetTokens: 10000 };
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

// "<YYYY-MM-DD HH:MM UTC>", used for the Session Summary title so it's stable
// regardless of the machine's local timezone.
export function utcMinute(iso) { return `${iso.slice(0, 16).replace("T", " ")} UTC`; }
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
  fs.writeFileSync(file, prompt);
  try { return execSync(cmd, { input: prompt, encoding: "utf8", env: { ...process.env, MEMORY_PROMPT_FILE: file }, timeout: 180_000, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] }); }
  finally { fs.rmSync(file, { force: true }); }
}
const OBS_OUT = /^\[(low|medium|high|critical)\]\s+(.+?)\s*\|\s*([A-Za-z0-9,_-]+)\s*$/;
const REF_OUT = /^(.+?)\s*<-\s*([a-f0-9]{12}(?:,[a-f0-9]{12})*)\s*$/;
const minute = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

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
  delete state.lastError;
  saveState(bundle, state); // transcriptBytes/foldedAt untouched: the checkpoint does not advance
  return { observations: 0, reflected: false, dropped: 0 };
}

function runFold(bundle, opts) {
  const { session, actor, cwd, finalize = false, summarizeCmd } = opts;
  const state = loadState(bundle, session);
  const dir = bundle.dir(opts.projectId ?? projectIdFor(cwd));
  const now = new Date().toISOString();
  let rel = state.rel, concept;
  if (rel) { try { concept = bundle.readConcept(rel); } catch { rel = null; } }

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
    const out = runSummarizer(summarizeCmd, OBSERVER_PROMPT(body.reflections, body.observations.slice(-20), serializeEntries(entries)));
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const line of out.split("\n")) {
      const m = OBS_OUT.exec(line.trim()); if (!m) continue;
      const ids = m[3].split(",").filter((id) => byId.has(id)); if (!ids.length) continue;
      if (findSecret(m[2])) continue; // never persist a secret into the concept
      const id = newId();
      added.push({ id, at: minute(byId.get(ids[0]).at), relevance: m[1], content: m[2] });
      sources.push({ resource: ids.join(","), id });
    }
  }
  body.observations.push(...added);
  state.observedSinceReflect = (state.observedSinceReflect ?? 0) + estimateTokens(added.map((o) => o.content).join("\n"));
  let reflected = false;
  if (body.observations.length && state.observedSinceReflect >= settings.reflectAfterTokens) {
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
    // The reflector ran either way; don't let a garbled response re-trigger it
    // on the same backlog forever.
    state.observedSinceReflect = 0;
    if (next.length) { body.reflections = next; reflected = true; }
  }
  const pruned = pruneObservations({ observations: body.observations, reflections: body.reflections, maxTokens: settings.observationsMaxTokens, targetTokens: settings.observationsTargetTokens });
  body.observations = pruned.observations;
  const dropped = new Set(pruned.dropped);
  const keptSources = concept.sources.filter((s) => !s.id || !dropped.has(s.id));

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
  delete state.lastError;
  Object.assign(state, { rel, transcriptBytes: bytes, foldedAt: now });
  saveState(bundle, state);
  return { observations: added.length, reflected, dropped: pruned.dropped.length };
}
