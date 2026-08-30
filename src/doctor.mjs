import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { check } from "./check.mjs";
import { hasRemote } from "./git.mjs";
const LEGACY = ["@guygrigsby/pi-claude-memory", "pi-memory", "pi-observational-memory"];
export function doctor(bundle, { env = process.env, home = os.homedir() } = {}) {
  const f = [];
  const add = (level, message) => f.push({ level, message });
  if (!bundle.exists()) { add("fail", `no bundle at ${bundle.root}; run memory init`); return { ok: false, findings: f }; }
  add("ok", `bundle ${bundle.root}`);
  hasRemote(bundle.root) ? add("ok", "git remote set") : add("warn", "no git remote; memory stays on this machine (memory init --remote URL)");
  const gitDir = path.join(bundle.root, ".git");
  if (fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"))) add("fail", "git rebase in progress; resolve by hand in the bundle");
  const c = check(bundle); c.ok ? add("ok", "check clean") : add("fail", `check: ${c.problems.length} problems (memory check)`);
  try { const s = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")); if (s.autoMemoryEnabled !== false) add("warn", 'Claude Code auto memory still on; set "autoMemoryEnabled": false in ~/.claude/settings.json'); } catch { /* no claude */ }
  try { const s = JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8")); const names = (s.packages ?? []).map((p) => (typeof p === "string" ? p : p.source).replace(/^npm:/, "")); for (const l of LEGACY) if (names.includes(l)) add("warn", `legacy pi package still installed: ${l} (pi remove npm:${l})`); } catch { /* no pi */ }
  for (const bin of ["pi", "claude", "git"]) { try { execFileSync("which", [bin], { stdio: "ignore", env }); add("ok", `${bin} on PATH`); } catch { add(bin === "git" ? "fail" : "warn", `${bin} not on PATH`); } }
  return { ok: !f.some((x) => x.level === "fail"), findings: f };
}
