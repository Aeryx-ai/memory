import test from "node:test";
import assert from "node:assert/strict";
import { appendLog } from "../src/log-file.mjs";
import { createConcept } from "../src/concept.mjs";
import { tmpBundle } from "./helpers.mjs";
test("log entries land under a date heading, newest date first", () => {
  const b = tmpBundle();
  const c = createConcept({ type: "Feedback", title: "A", actor: "human:guy", at: "2026-08-29T10:00:00Z" });
  appendLog(b, b.dir(null), { kind: "Creation", concept: c, rel: "feedback/a.md", actor: "human:guy", at: "2026-08-29T10:00:00Z" });
  appendLog(b, b.dir(null), { kind: "Update", concept: c, rel: "feedback/a.md", actor: "pi/kimi-k3", at: "2026-08-29T11:00:00Z" });
  appendLog(b, b.dir(null), { kind: "Deprecation", concept: c, rel: "feedback/a.md", actor: "human:guy", at: "2026-08-30T09:00:00Z" });
  const text = b.read("log.md");
  const i30 = text.indexOf("## 2026-08-30"), i29 = text.indexOf("## 2026-08-29");
  assert.ok(i30 > 0 && i29 > i30);
  assert.match(text, /## 2026-08-29\n\* \*\*Creation\*\*: \[A\]\(feedback\/a\.md\) by human:guy\n\* \*\*Update\*\*: \[A\]\(feedback\/a\.md\) by pi\/kimi-k3\n/);
  assert.equal(text.split("## 2026-08-29").length - 1, 1);
});
