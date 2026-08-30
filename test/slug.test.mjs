import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.mjs";
test("slug is lowercase ascii words joined by dashes, max 80 chars", () => {
  assert.equal(slugify("Reminders via Telegram!"), "reminders-via-telegram");
  assert.equal(slugify("  Ünïcode  --  Title "), "unicode-title");
  assert.equal(slugify("x".repeat(200)).length, 80);
});
test("empty slug refused", () => {
  assert.throws(() => slugify("!!!"), (e) => e.code === "refused");
});
