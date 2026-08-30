import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Bundle } from "../src/bundle.mjs";
export function tmpDir(prefix = "memory-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
export function tmpGitRepo(origin) {
  const dir = tmpDir("repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  return dir;
}
export function tmpBundle() {
  const root = path.join(tmpDir("bundle-"), "memory");
  const b = new Bundle(root);
  b.init({});
  return b;
}
