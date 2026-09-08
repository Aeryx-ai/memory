// test/golden/gen.mjs
// Produces memory-go/testdata/golden from ops.json, yaml-cases.json and
// cases.json by running the Node implementation. The Go SDK replays the same
// inputs and diffs its output against this tree. Run through `make goldens`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../../src/cli.mjs";
import { renderDocument, parseDocument } from "../../src/frontmatter.mjs";
import { slugify } from "../../src/slug.mjs";
import { parseActor } from "../../src/actor.mjs";
import { findSecret } from "../../src/secrets.mjs";
import { projectIdFromOrigin, assertProjectId } from "../../src/project-id.mjs";
import { parseSummaryBody, renderSummaryBody, pruneObservations, estimateTokens } from "../../src/summary.mjs";
import { OBSERVER_PROMPT, REFLECTOR_PROMPT, utcMinute, capDelta, sessionSlug } from "../../src/fold.mjs";
import { readDelta, serializeEntries } from "../../src/transcript.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, "..", "..");
const OUT = path.join(REPO, "memory-go", "testdata", "golden");
const FIXTURES = path.join(REPO, "test", "fixtures", "transcripts");
// The first entry's uuid in test/fixtures/transcripts/claude.jsonl. Cited by
// the dup and leaky summarizer commands below so a delta read from that
// fixture always resolves the id they claim an observation came from.
const CLAUDE_ID = "2a55d202-0256-4c6a-acb8-d2c40a35847f";
export const SUMMARIZERS = {
  observer: `sh -c 'grep -q "You distill" - && echo "Keep pnpm <- $(cat "$MEMORY_PROMPT_FILE" | grep -o "\\[[a-f0-9]\\{12\\}\\]" | head -1 | tr -d "[]")" || echo "[high] User requires pnpm, never npm | a1b2c3d4"'`,
  dup: `sh -c 'echo "[high] First observation | ${CLAUDE_ID}"; echo "[medium] Second observation | ${CLAUDE_ID}"'`,
  leaky: `sh -c 'echo "[high] Key is AKIAIOSFODNN7EXAMPLE | ${CLAUDE_ID}"'`,
  failing: `sh -c 'exit 7'`,
};

// A settable clock: every `new Date()` and `Date.now()` in src/ reads it, so
// generated.at, log headings, slugs and lock timestamps are reproducible.
let clock = Date.parse("2026-01-01T00:00:00.000Z");
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { a.length ? super(...a) : super(clock); }
  static now() { return clock; }
};
process.env.MEMORY_SYNC_INLINE = "1";

function tryCall(fn) { try { return { ok: fn() }; } catch (e) { return { error: e.code ?? "usage", message: e.message }; } }
function writeOut(rel, text) { const p = path.join(OUT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
function projectRepo(base, id) {
  const dir = path.join(base, "repos", id.replace(/[^a-z0-9]+/gi, "-"));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const [host, ...rest] = id.split("/");
    execFileSync("git", ["remote", "add", "origin", `git@${host}:${rest.join("/")}.git`], { cwd: dir });
  }
  return dir;
}
// 12-hex ids are random at fold time; rewrite them per file in order of first
// appearance so the tree is stable across regenerations. The Go replay applies
// the same rewrite to its own output before diffing.
// A 12-hex run that touches another hex digit or a dash is part of something
// longer (a uuid segment, a hash) and is left alone.
const hexOrDash = (ch) => ch !== undefined && /[a-f0-9-]/.test(ch);
export function normalizeIds(text) {
  const seen = new Map();
  return text.replace(/[a-f0-9]{12}/g, (m, offset) => {
    if (hexOrDash(text[offset - 1]) || hexOrDash(text[offset + 12])) return m;
    // "a" plus eleven digits: still twelve hex characters, never an integer
    // to the YAML core schema, so a normalized id in a sources[].id round trips.
    if (!seen.has(m)) seen.set(m, "a" + String(seen.size + 1).padStart(11, "0"));
    return seen.get(m);
  });
}
function copyTree(from, to, base) {
  const skip = new Set([".git", ".locks", ".state"]);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name.endsWith(".tmp")) continue;
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copyTree(src, dst, base); continue; }
    fs.writeFileSync(dst, normalizeIds(fs.readFileSync(src, "utf8").replaceAll(base, "<TMP>")));
  }
}

async function runOps() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "golden-"));
  const root = path.join(base, "memory");
  fs.mkdirSync(path.join(base, "transcripts"));
  for (const f of ["pi.jsonl", "claude.jsonl"]) fs.copyFileSync(path.join(FIXTURES, f), path.join(base, "transcripts", f));
  const ops = JSON.parse(fs.readFileSync(path.join(HERE, "ops.json"), "utf8"));
  const results = [];
  for (const [i, op] of ops.entries()) {
    clock = Date.parse(op.at);
    const argv = ["--dir", root];
    if (op.actor) argv.push("--actor", op.actor);
    if (op.project) argv.push("--cwd", projectRepo(base, op.project));
    if (op.root) argv.push("--root");
    argv.push(op.cmd);
    switch (op.cmd) {
      case "remember":
        argv.push("--type", op.type, "--title", op.title);
        if (op.description !== undefined) argv.push("--description", op.description);
        if (op.tags !== undefined) argv.push("--tags", op.tags);
        if (op.status !== undefined) argv.push("--status", op.status);
        for (const s of op.source ?? []) argv.push("--source", s);
        if (op.body !== undefined) argv.push("--body", op.body);
        else argv.push("--stdin-text", ""); // never read the generator's stdin
        break;
      case "deprecate": case "restore": argv.push(op.key); break;
      case "summarize": argv.push("--session", op.session, "--stdin-text", op.body); break;
      case "fold":
        argv.push("--session", op.session, "--transcript", path.join(base, "transcripts", op.transcript), "--format", op.format);
        if (op.finalize) argv.push("--finalize");
        if (op.summarizer) argv.push("--summarize-cmd", SUMMARIZERS[op.summarizer]);
        for (const [k, v] of Object.entries(op.settings ?? {})) argv.push(`--${k}`, String(v));
        break;
      case "context":
        if (op.session) argv.push("--session", op.session);
        if (op.summaries) argv.push("--summaries", String(op.summaries));
        if (op.budget) argv.push("--budget", String(op.budget));
        break;
      case "recall":
        if (op.type) argv.push("--type", op.type);
        if (op.deprecated) argv.push("--deprecated");
        argv.push(...op.query.split(" ").filter(Boolean));
        break;
    }
    const r = await run(argv);
    const stdout = r.stdout.replaceAll(base, "<TMP>");
    if (r.code !== (op.expect ?? 0)) throw new Error(`op ${i} ${op.cmd}: exit ${r.code}, want ${op.expect ?? 0}: ${r.stderr}`);
    if (op.expectStatus) { const j = JSON.parse(stdout); if (j.status !== op.expectStatus) throw new Error(`op ${i}: status ${j.status}, want ${op.expectStatus}`); }
    // Both can carry a fold-generated 12-hex observation/reflection id (context
    // prints Session Summary bodies verbatim; recall never does today, but stays
    // normalized too so it can't silently regress into a random-id leak later).
    if (op.cmd === "context") writeOut(`context/${op.out}.txt`, normalizeIds(stdout));
    if (op.cmd === "recall") writeOut(`recall/${op.out}.json`, normalizeIds(stdout));
    results.push({ i, cmd: op.cmd, code: r.code, stdout: normalizeIds(stdout) });
  }
  fs.mkdirSync(path.join(OUT, "bundle"), { recursive: true });
  copyTree(root, path.join(OUT, "bundle"), base);
  writeOut("ops.json", fs.readFileSync(path.join(HERE, "ops.json"), "utf8"));
  writeOut("results.jsonl", results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.rmSync(base, { recursive: true, force: true });
}

// Each case is written with Node's own parse of the rendered text as
// `parsed`, so the Go parser is measured against what yaml@2.9.0 reads back,
// not against the JSON input: the library drops a trailing space on the last
// line of a literal block scalar, and Go must do the same.
function yamlCases() {
  const cases = JSON.parse(fs.readFileSync(path.join(HERE, "yaml-cases.json"), "utf8"));
  const out = [];
  for (const c of cases) {
    const text = renderDocument(c.data, c.body);
    writeOut(`yaml/${c.name}.md`, text);
    const back = parseDocument(text);
    if (JSON.stringify(back.data) !== JSON.stringify(c.data)) console.error(`yaml case ${c.name}: Node's parse differs from the input; parsed is the golden`);
    out.push({ ...c, parsed: { data: back.data, body: back.body } });
  }
  writeOut("yaml/cases.json", JSON.stringify(out, null, 2) + "\n");
}

function valueCases() {
  const c = JSON.parse(fs.readFileSync(path.join(HERE, "cases.json"), "utf8"));
  const out = {};
  out.slug = c.slug.map((input) => ({ input, ...tryCall(() => slugify(input)) }));
  out.actor = c.actor.map((input) => ({ input, ...tryCall(() => parseActor(input)) }));
  out.secret = c.secret.map((input) => ({ input, expected: findSecret(input) }));
  out.projectid = c.projectid.map((input) => ({ input, ...tryCall(() => projectIdFromOrigin(input)) }));
  out.assertProjectID = c.assertProjectID.map((input) => ({ input, ...tryCall(() => assertProjectId(input)) }));
  out.summaryBodies = c.summaryBodies.map((input) => { const parsed = parseSummaryBody(input); return { input, parsed, rendered: renderSummaryBody(parsed) }; });
  out.prune = c.prune.map((input) => ({ input, expected: pruneObservations(input) }));
  out.prompts = { input: c.prompts, observer: OBSERVER_PROMPT(c.prompts.reflections, c.prompts.observations, c.prompts.delta), reflector: REFLECTOR_PROMPT(c.prompts.reflections, c.prompts.observations) };
  out.estimateTokens = c.estimateTokens.map((input) => ({ input, expected: estimateTokens(input) }));
  out.utcMinute = c.utcMinute.map((input) => ({ input, expected: utcMinute(input) }));
  out.sessionSlug = c.sessionSlug.map((input) => ({ input, expected: sessionSlug(input) }));
  out.capDelta = { input: c.capDelta, expected: capDelta(c.capDelta.entries, c.capDelta.maxTokens) };
  writeOut("cases.json", JSON.stringify(out, null, 2) + "\n");
  writeOut("prompts/observer.txt", out.prompts.observer);
  writeOut("prompts/reflector.txt", out.prompts.reflector);
  for (const [name, format] of [["pi", "pi"], ["claude", "claude"]]) {
    const p = path.join(FIXTURES, `${name}.jsonl`);
    writeOut(`transcript/${name}.txt`, serializeEntries(readDelta(p, format, 0).entries));
  }
  const pi = path.join(FIXTURES, "pi.jsonl");
  const from = Math.floor(fs.statSync(pi).size / 2);
  const d = readDelta(pi, "pi", from);
  writeOut("transcript/pi-from.json", JSON.stringify({ from, bytes: d.bytes, entries: d.entries }, null, 2) + "\n");
}

fs.rmSync(OUT, { recursive: true, force: true });
yamlCases();
valueCases();
await runOps();
console.log(`wrote ${OUT}`);
