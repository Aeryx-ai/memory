import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
export function tmpDir(prefix = "memory-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
export function tmpGitRepo(origin) {
  const dir = tmpDir("repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  return dir;
}
