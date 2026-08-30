import path from "node:path";
import { execFileSync } from "node:child_process";
import { MemoryError } from "./errors.mjs";

export function assertProjectId(id) {
  const parts = String(id).split("/");
  if (!id || /\s/.test(id) || id.startsWith("/") || parts.some((p) => p === "" || p === "." || p === ".."))
    throw new MemoryError("refused", `malformed project id ${JSON.stringify(id)}`);
  return id;
}

export function projectIdFromOrigin(url) {
  let u = url.trim();
  const scp = /^([^@\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u);
  let host, p;
  if (scp) { host = scp[2]; p = scp[3]; }
  else {
    u = u.replace(/^[a-z+]+:\/\//i, "");
    u = u.replace(/^[^@/]+@/, "");
    const i = u.indexOf("/"); host = u.slice(0, i); p = u.slice(i + 1);
  }
  host = host.toLowerCase().replace(/:\d+$/, "");
  p = p.replace(/\/+$/, "").replace(/\.git$/, "");
  return assertProjectId(`${host}/${p}`);
}

function git(cwd, args) {
  try { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim(); }
  catch { return null; }
}

export function localProjectId(cwd) { return assertProjectId(`local/${path.basename(path.resolve(cwd))}`); }

export function projectIdFor(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return localProjectId(cwd);
  const origin = git(top, ["remote", "get-url", "origin"]);
  return origin ? projectIdFromOrigin(origin) : localProjectId(top);
}
