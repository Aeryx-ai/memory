import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument, renderDocument } from "../src/frontmatter.mjs";

test("round trips frontmatter and body, preserving unknown keys", () => {
  const text = `---\ntype: Feedback\ntitle: X\ncustom_key: kept\ngenerated: { by: human:guy, at: 2026-08-29T00:00:00Z }\n---\nbody line\n`;
  const { data, body } = parseDocument(text);
  assert.equal(data.type, "Feedback");
  assert.equal(data.custom_key, "kept");
  assert.equal(data.generated.by, "human:guy");
  assert.equal(body, "body line\n");
  const again = parseDocument(renderDocument(data, body));
  assert.deepEqual(again.data, data);
  assert.equal(again.body, body);
});

test("no frontmatter yields empty data and whole text as body", () => {
  assert.deepEqual(parseDocument("just text"), { data: {}, body: "just text" });
});

test("timestamps stay strings, not Date objects", () => {
  const { data } = parseDocument(`---\nstale_after: 2026-09-01T00:00:00Z\n---\n`);
  assert.equal(typeof data.stale_after, "string");
});
