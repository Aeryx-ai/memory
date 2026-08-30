import test from "node:test";
import assert from "node:assert/strict";
import { recall } from "../src/recall.mjs";
import { createConcept, deprecate } from "../src/concept.mjs";
import { tmpBundle } from "./helpers.mjs";
const actor = "human:guy";
test("recall ranks title over description over body, spans root and project, hides deprecated", () => {
  const b = tmpBundle(); const root = b.dir(null), proj = b.dir("local/x");
  b.writeConcept(b.conceptRel(root, "Feedback", "telegram-rule"), createConcept({ type: "Feedback", title: "Telegram rule", description: "reminders", actor, at: "2026-08-01T00:00:00Z", body: "x" }));
  b.writeConcept(b.conceptRel(proj, "Project", "bot"), createConcept({ type: "Project", title: "Bot", description: "uses telegram", actor, at: "2026-08-02T00:00:00Z", body: "telegram telegram" }));
  b.writeConcept(b.conceptRel(proj, "Project", "old"), deprecate(createConcept({ type: "Project", title: "Old telegram", description: "", actor, at: "2026-08-03T00:00:00Z" }), actor, "2026-08-03T00:00:01Z"));
  const hits = recall(b, { projectId: "local/x", query: "telegram" });
  assert.deepEqual(hits.map((h) => [h.title, h.score]), [["Telegram rule", 3], ["Bot", 4]].sort((a, b2) => b2[1] - a[1]));
  assert.equal(recall(b, { projectId: "local/x", query: "telegram", includeDeprecated: true }).length, 3);
  assert.deepEqual(recall(b, { projectId: "local/x", type: "Project" }).map((h) => h.title), ["Bot"]);
});
