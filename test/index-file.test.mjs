import test from "node:test";
import assert from "node:assert/strict";
import { renderIndex, writeIndex } from "../src/index-file.mjs";
import { createConcept, deprecate } from "../src/concept.mjs";
import { tmpBundle } from "./helpers.mjs";
const actor = "human:guy", at = "2026-08-29T10:00:00Z";
const mk = (type, title, description, extra = {}) => createConcept({ type, title, description, actor, at, ...extra });
test("index groups by type in vocabulary order, skips deprecated, summaries newest first", () => {
  const entries = [
    { rel: "feedback/b.md", concept: mk("Feedback", "B", "second") },
    { rel: "feedback/a.md", concept: mk("Feedback", "A", "first") },
    { rel: "feedback/z.md", concept: deprecate(mk("Feedback", "Z", "gone"), actor, at) },
    { rel: "user/me.md", concept: mk("User", "Me", "who") },
    { rel: "session-summaries/20260828T100000Z-pi.md", concept: mk("Session Summary", "2026-08-28 pi", "old", { at: "2026-08-28T10:00:00Z" }) },
    { rel: "session-summaries/20260829T100000Z-pi.md", concept: mk("Session Summary", "2026-08-29 pi", "new") },
  ];
  const text = renderIndex(entries, { isRoot: true });
  assert.equal(text, `---\nokf_version: "0.2"\n---\n# User\n\n* [Me](user/me.md) - who\n\n# Feedback\n\n* [A](feedback/a.md) - first\n* [B](feedback/b.md) - second\n\n# Session Summary\n\n* [2026-08-29 pi](session-summaries/20260829T100000Z-pi.md) - new\n* [2026-08-28 pi](session-summaries/20260828T100000Z-pi.md) - old\n`);
  assert.doesNotMatch(renderIndex(entries, { isRoot: false }), /okf_version/);
});
test("writeIndex writes the directory index from disk", () => {
  const b = tmpBundle();
  const proj = b.dir("local/x");
  b.writeConcept(b.conceptRel(proj, "Project", "goal"), mk("Project", "Goal", "the goal"));
  writeIndex(b, proj);
  assert.equal(b.read("projects/local/x/index.md"), "# Project\n\n* [Goal](project/goal.md) - the goal\n");
});
