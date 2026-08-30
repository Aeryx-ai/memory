import test from "node:test";
import assert from "node:assert/strict";
import { renderContext } from "../src/context.mjs";
import { createConcept } from "../src/concept.mjs";
import { writeIndex } from "../src/index-file.mjs";
import { tmpBundle } from "./helpers.mjs";
const actor = "pi/kimi-k3";
function seed() {
  const b = tmpBundle(); const root = b.dir(null), proj = b.dir("github.com/a/b");
  b.writeConcept(b.conceptRel(root, "User", "me"), createConcept({ type: "User", title: "Me", description: "who", actor, at: "2026-08-01T00:00:00Z" }));
  for (const [n, at, session] of [["one", "2026-08-27T00:00:00Z", "pi:session/1"], ["two", "2026-08-28T00:00:00Z", "pi:session/2"], ["three", "2026-08-29T00:00:00Z", "pi:session/3"], ["four", "2026-08-30T00:00:00Z", "pi:session/4"]])
    b.writeConcept(b.conceptRel(proj, "Session Summary", n), createConcept({ type: "Session Summary", title: n, description: n, actor, at, sources: [{ resource: session }], body: `# Reflections\n\n# Observations\n[aaaaaaaaaaaa] ${at.slice(0, 10)} 00:00 [low] ${n}\n` }));
  writeIndex(b, root); writeIndex(b, proj);
  return b;
}
test("context has bundle index, project index and latest three summaries, newest first", () => {
  const b = seed();
  const text = renderContext(b, { projectId: "github.com/a/b" });
  assert.match(text, /^<memory-context bundle=".*" project="github.com\/a\/b">\n## Bundle\n# User\n\n\* \[Me\]\(user\/me\.md\) - who\n/);
  assert.doesNotMatch(text, /okf_version/);
  const order = ["### four", "### three", "### two"].map((h) => text.indexOf(h));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2]); assert.doesNotMatch(text, /### one/);
  assert.match(text, /<\/memory-context>\n$/);
  assert.equal(renderContext(b, { projectId: "github.com/a/b" }), text);
});
test("current session first, budget drops oldest, unknown project says so", () => {
  const b = seed();
  const text = renderContext(b, { projectId: "github.com/a/b", session: "pi:session/2" });
  assert.ok(text.indexOf("### two") < text.indexOf("### four"));
  const full = renderContext(b, { projectId: "github.com/a/b" });
  const budget = Buffer.byteLength(full) - 150;
  const small = renderContext(b, { projectId: "github.com/a/b", budget });
  assert.ok(Buffer.byteLength(small) <= budget + 20);
  assert.ok((small.match(/### /g) ?? []).length < (full.match(/### /g) ?? []).length);
  assert.match(renderContext(b, { projectId: "local/none" }), /## Project local\/none\nNo concepts yet\./);
});
