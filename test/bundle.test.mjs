import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Bundle } from "../src/bundle.mjs";
import { createConcept } from "../src/concept.mjs";
import { tmpBundle, tmpDir } from "./helpers.mjs";
const actor = "human:guy", at = "2026-08-29T10:00:00Z";
test("resolveRoot precedence", () => {
  assert.equal(Bundle.resolveRoot({ dir: "/x", env: { MEMORY_DIR: "/y" } }), "/x");
  assert.equal(Bundle.resolveRoot({ env: { MEMORY_DIR: "/y" } }), "/y");
  assert.equal(Bundle.resolveRoot({ env: { HOME: "/h" } }), "/h/.agents/memory");
});
test("init creates an OKF root and a git repo", () => {
  const b = tmpBundle();
  assert.match(fs.readFileSync(path.join(b.root, "index.md"), "utf8"), /^---\nokf_version: "0.2"\n---\n/);
  assert.match(fs.readFileSync(path.join(b.root, "log.md"), "utf8"), /\*\*Initialization\*\*/);
  assert.ok(fs.existsSync(path.join(b.root, ".git")));
  assert.match(fs.readFileSync(path.join(b.root, ".gitignore"), "utf8"), /\.state\//);
  b.init({}); // idempotent
});
test("dirs, concept paths, write and read", () => {
  const b = tmpBundle();
  const root = b.dir(null), proj = b.dir("github.com/a/b");
  assert.equal(root.isRoot, true); assert.equal(proj.rel, "projects/github.com/a/b");
  const c = createConcept({ type: "Project", title: "Cut over", actor, at, body: "x\n" });
  const rel = b.conceptRel(proj, "Project", "cut-over");
  assert.equal(rel, "projects/github.com/a/b/project/cut-over.md");
  b.writeConcept(rel, c);
  assert.deepEqual(b.readConcept(rel), c);
  assert.deepEqual(b.listConcepts(proj).map((e) => e.rel), [rel]);
  assert.equal(b.findConcept(proj, "cut-over").rel, rel);
  assert.throws(() => b.findConcept(proj, "missing"), (e) => e.code === "notfound");
  assert.deepEqual(b.dirs().map((d) => d.rel), ["", "projects/github.com/a/b"]);
});
test("dirs skips non-directory entries under projects/ and sorts by rel", () => {
  const b = tmpBundle();
  fs.mkdirSync(path.join(b.root, "projects"), { recursive: true });
  fs.writeFileSync(path.join(b.root, "projects", ".DS_Store"), "");
  const c = createConcept({ type: "Project", title: "X", actor, at, body: "x\n" });
  b.writeConcept(b.conceptRel(b.dir("b/two"), "Project", "x"), c);
  b.writeConcept(b.conceptRel(b.dir("a/one"), "Project", "x"), c);
  assert.deepEqual(b.dirs().map((d) => d.rel), ["", "projects/a/one", "projects/b/two"]);
});
test("findConcept: exact matches win, bare slug is refused when ambiguous", () => {
  const b = tmpBundle();
  const proj = b.dir("local/y");
  const cf = createConcept({ type: "Feedback", title: "X", actor, at, body: "x\n" });
  const cr = createConcept({ type: "Reference", title: "X", actor, at, body: "x\n" });
  b.writeConcept(b.conceptRel(proj, "Feedback", "x"), cf);
  b.writeConcept(b.conceptRel(proj, "Reference", "x"), cr);
  assert.equal(b.findConcept(proj, "feedback/x.md").rel, "projects/local/y/feedback/x.md");
  assert.throws(() => b.findConcept(proj, "x"), (e) => e.code === "refused" && e.message === "ambiguous key x: feedback/x.md, reference/x.md");
});
test("writeAtomic leaves no temp files and replaces content", () => {
  const b = tmpBundle();
  b.writeAtomic("feedback/a.md", "one"); b.writeAtomic("feedback/a.md", "two");
  assert.equal(b.read("feedback/a.md"), "two");
  assert.deepEqual(fs.readdirSync(path.join(b.root, "feedback")), ["a.md"]);
});
