import { parseArgs } from "node:util";
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

const GLOBAL = { dir: { type: "string" }, cwd: { type: "string" }, actor: { type: "string" }, md: { type: "boolean" }, root: { type: "boolean" }, "stdin-text": { type: "string" } };
const COMMANDS = {
  init: { remote: { type: "string" } },
  "project-id": {},
  remember: { type: { type: "string" }, title: { type: "string" }, description: { type: "string" }, tags: { type: "string" }, source: { type: "string", multiple: true }, status: { type: "string" }, body: { type: "string" } },
  deprecate: {}, restore: {}, show: {},
  _job: { index: { type: "string" }, commit: { type: "string" } },
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
  async _job(ctx, v) {
    try { runJobInline(ctx.bundle, v.index ?? "", v.commit ?? "memory: update"); }
    catch { /* detached job: always exits 0 */ }
    return undefined;
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
