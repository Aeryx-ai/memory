import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { projectIdFromOrigin, localProjectId, projectIdFor, assertProjectId } from "../src/project-id.mjs";
import { tmpGitRepo, tmpDir } from "./helpers.mjs";

test("origin url forms normalize to host/owner/repo", () => {
  for (const u of ["git@github.com:guygrigsby/x.git", "https://github.com/guygrigsby/x", "ssh://git@GitHub.com/guygrigsby/x.git", "https://user:tok@github.com/guygrigsby/x.git/"]) {
    assert.equal(projectIdFromOrigin(u), "github.com/guygrigsby/x", u);
  }
});

test("repo with origin, repo without, and no repo", () => {
  assert.equal(projectIdFor(tmpGitRepo("git@github.com:aeryx-ai/memory.git")), "github.com/aeryx-ai/memory");
  const bare = tmpGitRepo();
  assert.equal(projectIdFor(bare), `local/${path.basename(bare)}`);
  const plain = tmpDir();
  assert.equal(projectIdFor(plain), `local/${path.basename(plain)}`);
});

test("subdirectory of a repo resolves to the repo", () => {
  const r = tmpGitRepo("https://github.com/a/b");
  const sub = path.join(r, "deep", "er");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(projectIdFor(sub), "github.com/a/b");
});

test("assertProjectId refuses traversal", () => {
  for (const bad of ["", "../x", "/abs", "a b/c", "github.com/../x"]) {
    assert.throws(() => assertProjectId(bad), (e) => e.code === "refused");
  }
  assert.equal(assertProjectId("local/x"), "local/x");
});
