import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { git, withLock, commitAll, sync, hasRemote } from "../src/git.mjs";
import { tmpBundle, tmpDir } from "./helpers.mjs";
test("commitAll commits pending files and reports nothing on a clean tree", () => {
  const b = tmpBundle();
  assert.equal(commitAll(b.root, "memory: init"), true);
  assert.equal(commitAll(b.root, "memory: nothing"), false);
  assert.match(git(b.root, ["log", "--oneline"]), /memory: init/);
});
test("withLock runs once at a time and clears a stale lock", () => {
  const b = tmpBundle();
  let ran = 0;
  assert.equal(withLock(b.root, () => { ran++; assert.equal(withLock(b.root, () => ran++), false); }), true);
  assert.equal(ran, 1);
  const lock = path.join(b.root, ".locks", "git");
  fs.mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 600_000); fs.utimesSync(lock, old, old);
  assert.equal(withLock(b.root, () => ran++), true);
  assert.equal(ran, 2);
});
test("sync pulls and pushes against a bare remote; no remote is not an error", () => {
  const b = tmpBundle();
  commitAll(b.root, "memory: init");
  assert.equal(hasRemote(b.root), false);
  assert.deepEqual(sync(b.root, { pull: true, push: true }), { pulled: false, pushed: false, conflict: false });
  const bare = tmpDir("bare-"); execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  git(b.root, ["remote", "add", "origin", bare]);
  assert.equal(sync(b.root, { pull: false, push: true }).pushed, true);
  fs.writeFileSync(path.join(b.root, "feedback-x.md"), "x"); commitAll(b.root, "memory: x");
  assert.equal(sync(b.root, { pull: true, push: true }).pushed, true);
});
