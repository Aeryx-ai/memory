import test from "node:test";
import assert from "node:assert/strict";
import { TYPES, dirForType, typeForDir, legalTypes } from "../src/types.mjs";
test("five types with fixed directories", () => {
  assert.deepEqual(TYPES, ["User", "Feedback", "Project", "Reference", "Session Summary"]);
  assert.equal(dirForType("Session Summary"), "session-summaries");
  assert.equal(typeForDir("feedback"), "Feedback");
  assert.equal(typeForDir("nope"), undefined);
});
test("placement: User root only, Project project only", () => {
  assert.ok(legalTypes(true).includes("User") && !legalTypes(true).includes("Project"));
  assert.ok(legalTypes(false).includes("Project") && !legalTypes(false).includes("User"));
});
