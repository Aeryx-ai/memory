import test from "node:test";
import assert from "node:assert/strict";
import { parseActor } from "../src/actor.mjs";
test("three actor shapes", () => {
  assert.deepEqual(parseActor("pi/kimi-k3"), { value: "pi/kimi-k3", class: "agent" });
  assert.deepEqual(parseActor("human:guy"), { value: "human:guy", class: "human" });
  assert.deepEqual(parseActor("process:migrate-hermes"), { value: "process:migrate-hermes", class: "process" });
});
test("refuses anything else", () => {
  for (const bad of ["", "guy", "human:", "pi/", "/x", "a b/c", "human:a b"]) {
    assert.throws(() => parseActor(bad), (e) => e.code === "refused", bad);
  }
});
