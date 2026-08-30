import { parseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryError, exitCode } from "./errors.mjs";
import { Bundle } from "./bundle.mjs";
import { projectIdFor } from "./project-id.mjs";
import { createConcept, revise, deprecate, restore, renderConcept, validateConcept } from "./concept.mjs";
import { slugify } from "./slug.mjs";
import { writeIndex } from "./index-file.mjs";
import { appendLog } from "./log-file.mjs";
import { afterWrite } from "./jobs.mjs";
import { withLock, commitAll, sync } from "./git.mjs";
import { renderContext } from "./context.mjs";
import { recall } from "./recall.mjs";
import { check } from "./check.mjs";
import { doctor } from "./doctor.mjs";
import { fold, runFoldJob, markFoldError, utcMinute, sessionSummaryRel } from "./fold.mjs";
import { detectFormat, readEntries } from "./transcript.mjs";
import { parseSummaryBody } from "./summary.mjs";
import { migrate as runMigrate } from "./migrate/index.mjs";

const GLOBAL = { dir: { type: "string" }, cwd: { type: "string" }, actor: { type: "string" }, md: { type: "boolean" }, root: { type: "boolean" }, "stdin-text": { type: "string" } };
const FOLD_OPTIONS = {
  session: { type: "string" }, transcript: { type: "string" }, format: { type: "string" }, finalize: { type: "boolean" },
  "summarize-cmd": { type: "string" },
  observeAfterTokens: { type: "string" }, reflectAfterTokens: { type: "string" }, observationsMaxTokens: { type: "string" }, observationsTargetTokens: { type: "string" },
};
const COMMANDS = {
  init: { remote: { type: "string" } },
  "project-id": {},
  remember: { type: { type: "string" }, title: { type: "string" }, description: { type: "string" }, tags: { type: "string" }, source: { type: "string", multiple: true }, status: { type: "string" }, body: { type: "string" } },
  deprecate: {}, restore: {}, show: {},
  context: { session: { type: "string" }, summaries: { type: "string" }, budget: { type: "string" } },
  recall: { type: { type: "string" }, deprecated: { type: "boolean" } },
  index: {}, check: {}, sync: { pull: { type: "boolean" }, push: { type: "boolean" } }, doctor: {},
  _job: { index: { type: "string" }, commit: { type: "string" } },
  fold: FOLD_OPTIONS, _fold: FOLD_OPTIONS,
  summarize: { session: { type: "string" } },
  "recall-observation": { session: { type: "string" } },
  migrate: { "dry-run": { type: "boolean" }, home: { type: "string" }, "projects-root": { type: "string" } },
};

// argv carries global flags (with their values) ahead of the command word, e.g.
// `--dir X --cwd Y remember --type Z`. Walk past recognized global flags to find
// the command; a bare `.find(!startsWith("-"))` would instead match a flag's value.
function findCommandIndex(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) return a.startsWith("-") ? -1 : i;
    const [name, ...eq] = a.slice(2).split("=");
    const opt = GLOBAL[name];
    if (!opt) return -1;
    if (opt.type !== "boolean" && eq.length === 0) i++;
  }
  return -1;
}

export async function main(argv) {
  try {
    const idx = findCommandIndex(argv);
    const cmd = idx === -1 ? undefined : argv[idx];
    if (!cmd || !COMMANDS[cmd]) throw new MemoryError("usage", `usage: memory <${Object.keys(COMMANDS).filter((c) => !c.startsWith("_")).join("|")}> [options]`);
    const rest = [...argv.slice(0, idx), ...argv.slice(idx + 1)];
    const { values, positionals } = parseArgs({ args: rest, options: { ...GLOBAL, ...COMMANDS[cmd] }, allowPositionals: true, strict: true });
    const ctx = await context(values);
    const result = await HANDLERS[cmd](ctx, values, positionals);
    if (typeof result === "string") process.stdout.write(result);
    else if (result !== undefined) process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (e) {
    const code = e instanceof MemoryError ? e.code : "usage";
    process.stderr.write(JSON.stringify({ error: code, message: e.message }) + "\n");
    return exitCode(code);
  }
}

async function context(values) {
  const bundle = new Bundle(Bundle.resolveRoot({ dir: values.dir }));
  const cwd = values.cwd ? path.resolve(values.cwd) : process.cwd();
  const actor = values.actor ?? `human:${process.env.USER ?? os.userInfo().username}`;
  return { bundle, cwd, actor, md: !!values.md, now: () => new Date().toISOString(),
    readStdin: () => values["stdin-text"] !== undefined ? values["stdin-text"] : readAll() };
}
async function readAll() {
  if (process.stdin.isTTY) return "";
  let s = ""; for await (const chunk of process.stdin) s += chunk; return s;
}
function targetDir(ctx, values) {
  requireBundle(ctx.bundle);
  return values.root ? ctx.bundle.dir(null) : ctx.bundle.dir(projectIdFor(ctx.cwd));
}
function requireBundle(bundle) { if (!bundle.exists()) throw new MemoryError("notfound", `no bundle at ${bundle.root}; run memory init`); }
function need(values, key) { if (values[key] === undefined) throw new MemoryError("usage", `--${key} is required`); return values[key]; }
// recall-observation only ever reads back a transcript path this machine itself
// recorded in a concept's sources[]; refuse anything outside the user's home
// rather than following an arbitrary filesystem path.
function underHome(p) {
  const home = os.homedir();
  const resolved = path.resolve(p);
  return resolved === home || resolved.startsWith(home + path.sep);
}
function foldOpts(ctx, v) {
  const settings = {};
  for (const k of ["observeAfterTokens", "reflectAfterTokens", "observationsMaxTokens", "observationsTargetTokens"]) {
    if (v[k] !== undefined) settings[k] = Number(v[k]);
  }
  return { session: need(v, "session"), actor: ctx.actor, transcript: need(v, "transcript"), cwd: ctx.cwd, format: v.format, finalize: !!v.finalize, summarizeCmd: v["summarize-cmd"], settings };
}

export function runJobInline(bundle, dirRel, message) {
  withLock(bundle.root, () => {
    const dir = dirRel ? bundle.dir(dirRel.replace(/^projects\//, "")) : bundle.dir(null);
    writeIndex(bundle, dir);
    commitAll(bundle.root, message);
    sync(bundle.root, { pull: false, push: true });
  });
}
function afterConceptWrite(ctx, dir, { kind, concept, rel, at, message }) {
  appendLog(ctx.bundle, dir, { kind, concept, rel, actor: ctx.actor, at });
  if (process.env.MEMORY_SYNC_INLINE === "1") runJobInline(ctx.bundle, dir.rel, message);
  else afterWrite(ctx.bundle, { dirRel: dir.rel, message });
}

const HANDLERS = {
  async init(ctx, v) { ctx.bundle.init({ remote: v.remote }); return { root: ctx.bundle.root }; },
  async "project-id"(ctx) { return { projectId: projectIdFor(ctx.cwd) }; },
  async remember(ctx, v) {
    const dir = targetDir(ctx, v);
    const type = need(v, "type"), title = need(v, "title");
    const body = v.body ?? (await ctx.readStdin());
    const at = ctx.now();
    const sources = (v.source ?? []).map((resource) => ({ resource }));
    const tags = v.tags ? v.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    const rel = ctx.bundle.conceptRel(dir, type, slugify(title));
    let existing = null;
    try { existing = ctx.bundle.readConcept(rel); }
    catch (e) { if (!(e instanceof MemoryError) || e.code !== "notfound") throw e; }
    const concept = existing
      ? revise(existing, { title, description: v.description, tags, body, sources, status: v.status }, ctx.actor, at)
      : createConcept({ type, title, description: v.description, tags: tags ?? [], status: v.status, actor: ctx.actor, at, sources, body });
    validateConcept(concept, { isRoot: dir.isRoot });
    ctx.bundle.writeConcept(rel, concept);
    afterConceptWrite(ctx, dir, { kind: existing ? "Update" : "Creation", concept, rel, at, message: `memory: remember ${title}` });
    return { rel, created: !existing };
  },
  async deprecate(ctx, v, [key]) { return transition(ctx, v, key, deprecate, "Deprecation"); },
  async restore(ctx, v, [key]) { return transition(ctx, v, key, restore, "Update"); },
  async show(ctx, v, [key]) {
    const { concept } = ctx.bundle.findConcept(targetDir(ctx, v), key ?? need(v, "key"));
    return ctx.md ? renderConcept(concept) : concept;
  },
  async context(ctx, v) {
    requireBundle(ctx.bundle);
    return renderContext(ctx.bundle, { projectId: projectIdFor(ctx.cwd), session: v.session, summaries: v.summaries ? Number(v.summaries) : 3, budget: v.budget ? Number(v.budget) : undefined });
  },
  async recall(ctx, v, words) {
    requireBundle(ctx.bundle);
    const hits = recall(ctx.bundle, { projectId: projectIdFor(ctx.cwd), type: v.type, query: words.join(" "), includeDeprecated: !!v.deprecated });
    return ctx.md ? hits.map((h) => `* [${h.title}](${h.rel}) - ${h.description} (${h.type}, ${h.score})`).join("\n") + "\n" : hits;
  },
  async index(ctx) { requireBundle(ctx.bundle); const dirs = ctx.bundle.dirs(); for (const d of dirs) writeIndex(ctx.bundle, d); return { dirs: dirs.length }; },
  async check(ctx) {
    requireBundle(ctx.bundle);
    const r = check(ctx.bundle);
    if (!r.ok) { process.stdout.write(JSON.stringify(r) + "\n"); throw new MemoryError("check", `${r.problems.length} problems`); }
    return r;
  },
  async sync(ctx, v) {
    requireBundle(ctx.bundle);
    const both = !v.pull && !v.push; let r = { skipped: true };
    const ran = withLock(ctx.bundle.root, () => {
      commitAll(ctx.bundle.root, "memory: sync");
      r = sync(ctx.bundle.root, { pull: both || !!v.pull, push: both || !!v.push });
      if (r.pulled) for (const d of ctx.bundle.dirs()) writeIndex(ctx.bundle, d);
      if (r.pulled && commitAll(ctx.bundle.root, "memory: regenerate index after pull")) {
        const second = sync(ctx.bundle.root, { pull: false, push: both || !!v.push });
        r = { ...r, pushed: second.pushed, conflict: r.conflict || second.conflict };
      }
    });
    if (!ran) return { skipped: true };
    if (r.conflict) throw new MemoryError("sync", "rebase conflict; resolve in the bundle by hand");
    return r;
  },
  async doctor(ctx) {
    const r = doctor(ctx.bundle, { home: process.env.HOME });
    if (!r.ok) { process.stdout.write(JSON.stringify(r) + "\n"); throw new MemoryError("check", "doctor found failures"); }
    return r;
  },
  async _job(ctx, v) {
    try { runJobInline(ctx.bundle, v.index ?? "", v.commit ?? "memory: update"); }
    catch { /* detached job: always exits 0 */ }
    return undefined;
  },
  async fold(ctx, v) { requireBundle(ctx.bundle); return fold(ctx.bundle, foldOpts(ctx, v)); },
  async _fold(ctx, v) {
    try { requireBundle(ctx.bundle); return runFoldJob(ctx.bundle, foldOpts(ctx, v)); }
    catch (e) {
      // Detached job: never throw. Best-effort record the failure against the
      // session's checkpoint so it's visible on the next fold or to doctor.
      // Only when the bundle actually exists: without one there's nowhere to
      // record it, and writing under .state/ would create a stray directory.
      if (v.session && ctx.bundle.exists()) { try { markFoldError(ctx.bundle, v.session, e.message); } catch { /* nothing more we can do */ } }
      return undefined;
    }
  },
  async summarize(ctx, v) {
    const dir = targetDir(ctx, v);
    const session = need(v, "session");
    const body = await ctx.readStdin();
    const at = ctx.now();
    const existing = ctx.bundle.listConcepts(dir).find((e) => e.concept.type === "Session Summary" && e.concept.sources.some((s) => s.resource === session));
    if (existing && parseSummaryBody(existing.concept.body).observations.length) {
      throw new MemoryError("refused", `session ${session} already has folded observations at ${existing.rel}; summarize would overwrite them`);
    }
    const rel = existing?.rel ?? sessionSummaryRel(ctx.bundle, dir, at, ctx.actor);
    const concept = existing
      ? revise(existing.concept, { body }, ctx.actor, at)
      : createConcept({ type: "Session Summary", title: `${utcMinute(at)} ${ctx.actor}`, description: `Session ${session}`, actor: ctx.actor, at, sources: [{ resource: session }], body });
    ctx.bundle.writeConcept(rel, concept);
    afterConceptWrite(ctx, dir, { kind: existing ? "Update" : "Creation", concept, rel, at, message: `memory: summarize ${session}` });
    return { rel, created: !existing };
  },
  async "recall-observation"(ctx, v, [id]) {
    if (!id) throw new MemoryError("usage", "observation id required");
    const dir = targetDir(ctx, v);
    for (const { concept } of ctx.bundle.listConcepts(dir).filter((e) => e.concept.type === "Session Summary")) {
      const body = parseSummaryBody(concept.body);
      const obs = body.observations.find((o) => o.id === id);
      const ref = body.reflections.find((r) => r.id === id);
      if (!obs && !ref) continue;
      const ids = obs ? [id] : ref.supports;
      const entryIds = concept.sources.filter((s) => s.id && ids.includes(s.id)).flatMap((s) => s.resource.split(","));
      const transcript = concept.sources.find((s) => s.title === "transcript")?.resource;
      if (transcript && !underHome(transcript)) return { id, line: obs ?? ref, entries: [], reason: "transcript outside home" };
      const entries = transcript && fs.existsSync(transcript) ? readEntries(transcript, detectFormat(transcript), entryIds) : [];
      return { id, line: obs ?? ref, entries };
    }
    throw new MemoryError("notfound", `no observation or reflection ${id}`);
  },
  async migrate(ctx, v, [store]) {
    requireBundle(ctx.bundle);
    return runMigrate(ctx.bundle, store ?? "all", { home: v.home, projectsRoot: v["projects-root"], dryRun: !!v["dry-run"] });
  },
};
async function transition(ctx, v, key, fn, kind) {
  if (!key) throw new MemoryError("usage", "concept key required");
  const dir = targetDir(ctx, v);
  const { rel, concept } = ctx.bundle.findConcept(dir, key);
  const at = ctx.now(), next = fn(concept, ctx.actor, at);
  ctx.bundle.writeConcept(rel, next);
  afterConceptWrite(ctx, dir, { kind, concept: next, rel, at, message: `memory: ${kind.toLowerCase()} ${concept.title}` });
  return { rel, status: next.status };
}
