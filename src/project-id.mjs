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

  // Reject filesystem paths
  if (u.startsWith("/") || u.startsWith(".") || u.startsWith("~") || /^[a-z]:/i.test(u)) {
    throw new MemoryError("refused", `malformed project id origin ${JSON.stringify(u)}`);
  }

  // Check if URL has a scheme
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(u);

  let host, p;

  if (hasScheme) {
    // Strip scheme
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    // Strip optional user[:pass]@
    u = u.replace(/^[^@/]+@/, "");
    // Split at first /
    const i = u.indexOf("/");
    host = u.slice(0, i);
    p = u.slice(i + 1);
  } else {
    // Try SCP form only if no scheme
    const scp = /^([^@\s]+@)?([^:/\s]+):(.+)$/.exec(u);
    if (scp) {
      host = scp[2];
      p = scp[3];
    } else {
      // No scheme and not SCP form
      throw new MemoryError("refused", `malformed project id origin ${JSON.stringify(url.trim())}`);
    }
  }

  // Normalize host: lowercase and strip port
  host = host.toLowerCase().replace(/:\d+$/, "");
  // Normalize path: strip trailing slashes and .git
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
  if (!origin) return localProjectId(top);
  try {
    return projectIdFromOrigin(origin);
  } catch (e) {
    if (e.code === "refused") return localProjectId(top);
    throw e;
  }
}
