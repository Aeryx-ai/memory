import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { check } from "../src/check.mjs";
import { createConcept } from "../src/concept.mjs";
import { writeIndex } from "../src/index-file.mjs";
import { tmpBundle } from "./helpers.mjs";
test("check finds bad frontmatter, illegal placement, secrets and stale indexes", () => {
  const b = tmpBundle(); const root = b.dir(null);
  b.writeConcept(b.conceptRel(root, "Feedback", "ok"), createConcept({ type: "Feedback", title: "Ok", actor: "human:guy", at: "2026-08-01T00:00:00Z" }));
  writeIndex(b, root);
  assert.deepEqual(check(b), { ok: true, problems: [] });
  fs.writeFileSync(path.join(b.root, "feedback", "bad.md"), "no frontmatter");
  fs.mkdirSync(path.join(b.root, "project"), { recursive: true });
  fs.writeFileSync(path.join(b.root, "project", "wrong.md"), "---\ntype: Project\ntitle: W\nstatus: stable\ngenerated: { by: human:guy, at: 2026-08-01T00:00:00Z }\n---\n");
  fs.writeFileSync(path.join(b.root, "feedback", "leak.md"), "---\ntype: Feedback\ntitle: L\nstatus: stable\ngenerated: { by: human:guy, at: 2026-08-01T00:00:00Z }\n---\nAKIAIOSFODNN7EXAMPLE\n");
  // wrong.md parses fine (only its placement is illegal), so it is part of the
  // set writeIndex would render; regenerate so the index isn't independently stale.
  writeIndex(b, root);
  const r = check(b);
  assert.equal(r.ok, false);
  const rels = r.problems.map((p) => p.rel).sort();
  assert.deepEqual(rels, ["feedback/bad.md", "feedback/leak.md", "project/wrong.md"]);
  assert.ok(!rels.includes("index.md"));

  // a new legal concept added without regenerating the index makes it stale
  b.writeConcept(b.conceptRel(root, "Feedback", "fresh"), createConcept({ type: "Feedback", title: "Fresh", actor: "human:guy", at: "2026-08-02T00:00:00Z" }));
  const r2 = check(b);
  assert.ok(r2.problems.some((p) => p.rel === "index.md"));

  writeIndex(b, root);
  const r3 = check(b);
  assert.deepEqual(r3.problems.map((p) => p.rel).sort(), ["feedback/bad.md", "feedback/leak.md", "project/wrong.md"]);
});
