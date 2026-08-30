import test from "node:test";
import assert from "node:assert/strict";
import { createConcept, parseConcept, renderConcept, validateConcept, deprecate, restore, revise } from "../src/concept.mjs";
const at = "2026-08-29T10:00:00Z";
const base = { type: "Feedback", title: "Reminders via Telegram", description: "remind me means a Telegram job", actor: "claude-code/claude-fable-5", at, sources: [{ resource: "claude-code:session/abc" }], body: "Body.\n" };
test("create fills defaults and renders OKF frontmatter", () => {
  const c = createConcept(base);
  assert.equal(c.status, "stable");
  assert.deepEqual(c.generated, { by: "claude-code/claude-fable-5", at });
  const text = renderConcept(c);
  assert.match(text, /^---\ntype: Feedback\ntitle: Reminders via Telegram\n/);
  assert.match(text, /generated:\n  by: claude-code\/claude-fable-5\n  at: 2026-08-29T10:00:00Z/);
  assert.match(text, /\n---\nBody\.\n$/);
  assert.deepEqual(parseConcept(text), c);
});
test("refusals: bad type, empty title, bad actor, secret, illegal placement", () => {
  assert.throws(() => createConcept({ ...base, type: "Note" }), (e) => e.code === "refused");
  assert.throws(() => createConcept({ ...base, title: " " }), (e) => e.code === "refused");
  assert.throws(() => createConcept({ ...base, actor: "guy" }), (e) => e.code === "refused");
  assert.throws(() => createConcept({ ...base, body: "key AKIAIOSFODNN7EXAMPLE" }), (e) => /secret/.test(e.message));
  assert.throws(() => validateConcept(createConcept({ ...base, type: "User" }), { isRoot: false }), (e) => e.code === "refused");
  assert.throws(() => validateConcept(createConcept({ ...base, type: "Project" }), { isRoot: true }), (e) => e.code === "refused");
});
test("unknown frontmatter keys survive parse and render", () => {
  const text = renderConcept(createConcept(base)).replace("---\nBody", "custom_key: kept\n---\nBody");
  const c = parseConcept(text);
  assert.equal(c.extra.custom_key, "kept");
  assert.match(renderConcept(c), /custom_key: kept/);
});
test("transitions", () => {
  const c = createConcept(base);
  const d = deprecate(c, "human:guy", "2026-08-30T00:00:00Z");
  assert.equal(d.status, "deprecated"); assert.equal(d.generated.by, "human:guy");
  assert.throws(() => deprecate(d, "human:guy", at), (e) => e.code === "refused");
  assert.equal(restore(d, "human:guy", at).status, "stable");
  assert.throws(() => restore(c, "human:guy", at), (e) => e.code === "refused");
  const r = revise(c, { body: "New.\n", sources: [{ resource: "pi:session/xyz" }] }, "pi/kimi-k3", "2026-08-31T00:00:00Z");
  assert.equal(r.body, "New.\n"); assert.equal(r.generated.by, "pi/kimi-k3");
  assert.deepEqual(r.sources.map((s) => s.resource), ["claude-code:session/abc", "pi:session/xyz"]);
});
test("duplicate source refused only when resource and id both match", () => {
  assert.throws(() => createConcept({ ...base, sources: [{ resource: "a" }, { resource: "a" }] }), (e) => e.code === "refused");
  assert.throws(() => createConcept({ ...base, sources: [{ resource: "a", id: "x" }, { resource: "a", id: "x" }] }), (e) => e.code === "refused");
});
test("same resource with different ids is accepted (many observations can cite one entry)", () => {
  const c = createConcept({ ...base, sources: [{ resource: "a", id: "x" }, { resource: "a", id: "y" }] });
  assert.deepEqual(c.sources.map((s) => s.id), ["x", "y"]);
});
test("parse without type refused", () => {
  assert.throws(() => parseConcept("---\ntitle: x\n---\n"), (e) => e.code === "refused");
});
test("revise promotes draft to stable, refuses other status changes", () => {
  const draft = createConcept({ ...base, status: "draft" });
  const promoted = revise(draft, { status: "stable" }, "human:guy", at);
  assert.equal(promoted.status, "stable");
  assert.throws(() => revise(createConcept(base), { status: "draft" }, "human:guy", at), (e) => e.code === "refused");
  const deprecated = deprecate(createConcept(base), "human:guy", at);
  assert.throws(() => revise(deprecated, { status: "stable" }, "human:guy", at), (e) => e.code === "refused");
});
test("createConcept refuses starting deprecated", () => {
  assert.throws(() => createConcept({ ...base, status: "deprecated" }), (e) => e.code === "refused");
});
test("parseConcept reads a deprecated document", () => {
  const deprecated = deprecate(createConcept(base), "human:guy", at);
  const parsed = parseConcept(renderConcept(deprecated));
  assert.equal(parsed.status, "deprecated");
});
test("concepts are deeply frozen", () => {
  const c = createConcept(base);
  assert.throws(() => { c.generated.by = "someone-else"; }, TypeError);
  assert.throws(() => { c.sources.push({ resource: "z" }); }, TypeError);
  assert.equal(c.generated.by, "claude-code/claude-fable-5");
  assert.equal(c.sources.length, 1);
});
