import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { MemoryError } from "./errors.mjs";
const STALE_MS = 300_000;
export function git(root, args, { allowFail = false } = {}) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (e) { if (allowFail) return null; throw new MemoryError("sync", `git ${args.join(" ")}: ${e.stderr?.toString().trim() || e.message}`); }
}
export function withLock(root, fn) {
  const lock = path.join(root, ".locks", "git");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); }
  catch {
    let stale = false;
    try { stale = Date.now() - fs.statSync(lock).mtimeMs > STALE_MS; } catch { stale = true; }
    if (!stale) return false;
    fs.rmSync(lock, { recursive: true, force: true });
    try { fs.mkdirSync(lock); } catch { return false; }
  }
  try { fn(); return true; } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
export function commitAll(root, message) {
  git(root, ["add", "-A"]);
  if (!git(root, ["status", "--porcelain"])) return false;
  git(root, ["-c", "user.name=memory", "-c", "user.email=memory@localhost", "commit", "-q", "-m", message]);
  return true;
}
export function hasRemote(root) { return git(root, ["remote", "get-url", "origin"], { allowFail: true }) != null; }
export function sync(root, { pull = true, push = true } = {}) {
  const out = { pulled: false, pushed: false, conflict: false };
  if (!hasRemote(root)) return out;
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (pull) {
    const r = git(root, ["pull", "--rebase", "-q", "origin", branch], { allowFail: true });
    if (r == null) {
      const rebasing = fs.existsSync(path.join(root, ".git", "rebase-merge")) || fs.existsSync(path.join(root, ".git", "rebase-apply"));
      if (rebasing) { git(root, ["rebase", "--abort"], { allowFail: true }); out.conflict = true; return out; }
    } else out.pulled = true;
  }
  if (push) out.pushed = git(root, ["push", "-q", "-u", "origin", branch], { allowFail: true }) != null;
  return out;
}
export function spawnDetached(argv, { env = process.env } = {}) {
  const child = spawn(process.execPath, argv, { detached: true, stdio: "ignore", env });
  child.unref();
}
