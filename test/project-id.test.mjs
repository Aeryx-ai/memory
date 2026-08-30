import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

test("scheme urls with ports normalize correctly", () => {
  assert.equal(projectIdFromOrigin("ssh://git@github.com:2222/guygrigsby/x.git"), "github.com/guygrigsby/x");
  assert.equal(projectIdFromOrigin("https://gitlab.example.com:8443/team/repo.git"), "gitlab.example.com/team/repo");
});

test("local filesystem path origins fall back to local id", () => {
  const bareOrigin = tmpDir();
  execFileSync("git", ["init", "-q", "--bare"], { cwd: bareOrigin });
  const repo = tmpGitRepo(bareOrigin);
  assert.equal(projectIdFor(repo), `local/${path.basename(repo)}`);
});

test("projectIdFromOrigin rejects filesystem paths", () => {
  for (const bad of ["/Users/guy/repos/upstream.git", "./relative/path", "~/home/path"]) {
    assert.throws(() => projectIdFromOrigin(bad), (e) => e.code === "refused");
  }
});
