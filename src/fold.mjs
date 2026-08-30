import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConcept, revise } from "./concept.mjs";
import { projectIdFor } from "./project-id.mjs";
import { appendLog } from "./log-file.mjs";
import { afterWrite } from "./jobs.mjs";
import { spawnDetached } from "./git.mjs";
import { readDelta, detectFormat, serializeEntries } from "./transcript.mjs";
import { parseSummaryBody, renderSummaryBody, pruneObservations, newId, estimateTokens, RELEVANCE } from "./summary.mjs";

export const DEFAULTS = { observeAfterTokens: 8000, reflectAfterTokens: 20000, observationsMaxTokens: 20000, observationsTargetTokens: 10000 };
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "memory.mjs");
const sessionSlug = (s) => s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

export function OBSERVER_PROMPT(reflections, recent, delta) {
  return `You extract observations from a coding-agent transcript delta. Output only lines of the form:\n[relevance] one-line observation | entryId,entryId\nrelevance is one of ${RELEVANCE.join(", ")}. Record decisions, constraints, preferences, completed work, rejected approaches, open items. Skip chatter. Cite the transcript entry ids the observation came from.\n\nExisting reflections:\n${reflections.map((r) => `[${r.id}] ${r.content}`).join("\n") || "(none)"}\n\nRecent observations:\n${recent.map((o) => `[${o.id}] ${o.at} [${o.relevance}] ${o.content}`).join("\n") || "(none)"}\n\nTranscript delta:\n${delta}`;
}
export function REFLECTOR_PROMPT(reflections, observations) {
  return `You distill durable reflections from observations. Output only lines of the form:\none-line durable fact <- obsId,obsId\nA reflection is a stable fact about the user, project, decision or constraint. Cite every observation whose durable meaning it preserves, and only those.\n\nCurrent reflections:\n${reflections.map((r) => `[${r.id}] ${r.content} <- ${r.supports.join(",")}`).join("\n") || "(none)"}\n\nObservations:\n${observations.map((o) => `[${o.id}] ${o.at} [${o.relevance}] ${o.content}`).join("\n")}`;
}

function statePath(bundle, session) { return bundle.statePath(`${sessionSlug(session)}.json`); }
function loadState(bundle, session) { try { return JSON.parse(fs.readFileSync(statePath(bundle, session), "utf8")); } catch { return { session, transcriptBytes: 0, foldedAt: null, rel: null, observedSinceReflect: 0 }; } }
function saveState(bundle, state) { fs.writeFileSync(statePath(bundle, state.session), JSON.stringify(state)); }

export function fold(bundle, opts) {
  const { session, transcript, finalize = false } = opts;
  const state = loadState(bundle, session);
  const size = fs.existsSync(transcript) ? fs.statSync(transcript).size : 0;
  if (size < state.transcriptBytes) state.transcriptBytes = 0;
  const settings = { ...DEFAULTS, ...(opts.settings ?? {}) };
  const pending = estimateTokens("x".repeat(Math.max(0, size - state.transcriptBytes)));
  if (!finalize && pending < settings.observeAfterTokens) return { status: "skipped", reason: `${pending} tokens pending` };
  if (process.env.MEMORY_SYNC_INLINE === "1") return { status: "folded", ...runFoldJob(bundle, opts) };
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
  try { return execSync(cmd, { input: prompt, encoding: "utf8", env: { ...process.env, MEMORY_PROMPT_FILE: file }, timeout: 180_000, stdio: ["pipe", "pipe", "ignore"] }); }
  finally { fs.rmSync(file, { force: true }); }
}
const OBS_OUT = /^\[(low|medium|high|critical)\]\s+(.+?)\s*\|\s*([A-Za-z0-9,_-]+)\s*$/;
const REF_OUT = /^(.+?)\s*<-\s*([a-f0-9]{12}(?:,[a-f0-9]{12})*)\s*$/;
const minute = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

export function runFoldJob(bundle, opts) {
  const { session, actor, transcript, cwd, finalize = false, force = false } = opts;
  const settings = { ...DEFAULTS, ...(opts.settings ?? {}) };
  const format = opts.format ?? detectFormat(transcript);
  const lock = path.join(bundle.root, ".locks", `fold-${sessionSlug(session)}`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch { return { observations: 0, reflected: false, dropped: 0, skipped: "locked" }; }
  try {
    const state = loadState(bundle, session);
    const dir = bundle.dir(opts.projectId ?? projectIdFor(cwd));
    const now = new Date().toISOString();
    let rel = state.rel, concept;
    if (rel) { try { concept = bundle.readConcept(rel); } catch { rel = null; } }
    if (!rel) {
      const stamp = now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      rel = bundle.conceptRel(dir, "Session Summary", `${stamp}-${sessionSlug(actor)}`);
      concept = createConcept({ type: "Session Summary", title: `${minute(now)} ${actor}`, description: `Session ${session}`, status: "draft", actor, at: now, sources: [{ resource: session }, { resource: transcript, title: "transcript" }], body: renderSummaryBody({ reflections: [], observations: [] }) });
      bundle.writeConcept(rel, concept);
      appendLog(bundle, dir, { kind: "Creation", concept, rel, actor, at: now });
    }
    const { entries, bytes } = readDelta(transcript, format, state.transcriptBytes);
    const body = parseSummaryBody(concept.body);
    const added = [], sources = [];
    if (entries.length && (force || finalize || estimateTokens(serializeEntries(entries)) >= settings.observeAfterTokens)) {
      const out = opts.summarizeCmd ? runSummarizer(opts.summarizeCmd, OBSERVER_PROMPT(body.reflections, body.observations.slice(-20), serializeEntries(entries))) : "";
      const byId = new Map(entries.map((e) => [e.id, e]));
      for (const line of out.split("\n")) {
        const m = OBS_OUT.exec(line.trim()); if (!m) continue;
        const ids = m[3].split(",").filter((id) => byId.has(id)); if (!ids.length) continue;
        const id = newId();
        added.push({ id, at: minute(byId.get(ids[0]).at), relevance: m[1], content: m[2] });
        sources.push({ resource: ids.join(","), id });
      }
    }
    body.observations.push(...added);
    state.observedSinceReflect = (state.observedSinceReflect ?? 0) + estimateTokens(added.map((o) => o.content).join("\n"));
    let reflected = false;
    if (body.observations.length && state.observedSinceReflect >= settings.reflectAfterTokens && opts.summarizeCmd) {
      const out = runSummarizer(opts.summarizeCmd, REFLECTOR_PROMPT(body.reflections, body.observations));
      const known = new Set(body.observations.map((o) => o.id));
      const next = [];
      for (const line of out.split("\n")) { const m = REF_OUT.exec(line.trim()); if (!m) continue; const supports = m[2].split(",").filter((id) => known.has(id)); if (supports.length) next.push({ id: newId(), content: m[1], supports }); }
      if (next.length) { body.reflections = next; reflected = true; state.observedSinceReflect = 0; }
    }
    const pruned = pruneObservations({ observations: body.observations, reflections: body.reflections, maxTokens: settings.observationsMaxTokens, targetTokens: settings.observationsTargetTokens });
    body.observations = pruned.observations;
    const dropped = new Set(pruned.dropped);
    const keptSources = concept.sources.filter((s) => !s.id || !dropped.has(s.id));
    concept = revise({ ...concept, sources: keptSources }, { body: renderSummaryBody(body), sources, ...(finalize ? { status: "stable" } : {}) }, actor, now);
    bundle.writeConcept(rel, concept);
    appendLog(bundle, dir, { kind: "Update", concept, rel, actor, at: now });
    afterWrite(bundle, { dirRel: dir.rel, message: `memory: fold ${session}` });
    Object.assign(state, { rel, transcriptBytes: bytes, foldedAt: now });
    saveState(bundle, state);
    return { observations: added.length, reflected, dropped: pruned.dropped.length };
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
