import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { doctor } from "../src/doctor.mjs";
import { tmpBundle, tmpDir } from "./helpers.mjs";

// A PATH containing only symlinks to the real `which` and `git` binaries:
// deterministic regardless of whether this machine happens to have pi/claude
// installed. `which` itself must be on the constructed PATH too, since
// execFileSync spawns it without a shell, resolving it via env.PATH.
function pathWithOnlyGit() {
  const dir = tmpDir("path-");
  for (const bin of ["which", "git"]) {
    const real = execFileSync("which", [bin], { encoding: "utf8" }).trim();
    fs.symlinkSync(real, path.join(dir, bin));
  }
  return dir;
}

test("doctor reports bundle present, remote absent and check clean", () => {
  const b = tmpBundle();
  const env = { PATH: pathWithOnlyGit() };
  const home = tmpDir("home-");
  const r = doctor(b, { env, home });
  assert.equal(r.ok, true);
  const msgs = r.findings.map((f) => f.message);
  assert.ok(msgs.some((m) => m.startsWith("bundle ")));
  assert.ok(msgs.includes("no git remote; memory stays on this machine (memory init --remote URL)"));
  assert.ok(msgs.includes("check clean"));
});

test("pi and claude absent from PATH warn by name; git present is ok", () => {
  const b = tmpBundle();
  const env = { PATH: pathWithOnlyGit() };
  const home = tmpDir("home-");
  const r = doctor(b, { env, home });
  assert.ok(r.findings.some((f) => f.level === "warn" && f.message === "pi not on PATH"));
  assert.ok(r.findings.some((f) => f.level === "warn" && f.message === "claude not on PATH"));
  assert.ok(r.findings.some((f) => f.level === "ok" && f.message === "git on PATH"));
});

test("legacy pi package warns by name", () => {
  const b = tmpBundle();
  const env = { PATH: pathWithOnlyGit() };
  const home = tmpDir("home-");
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:pi-memory"] }));
  const r = doctor(b, { env, home });
  assert.ok(r.findings.some((f) => f.level === "warn" && f.message.includes("pi-memory")));
});

test("claude auto memory warns unless explicitly disabled", () => {
  const b = tmpBundle();
  const env = { PATH: pathWithOnlyGit() };
  const homeOn = tmpDir("home-");
  fs.mkdirSync(path.join(homeOn, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(homeOn, ".claude", "settings.json"), JSON.stringify({}));
  let r = doctor(b, { env, home: homeOn });
  assert.ok(r.findings.some((f) => f.level === "warn" && f.message.includes("autoMemoryEnabled")));

  const homeOff = tmpDir("home-");
  fs.mkdirSync(path.join(homeOff, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(homeOff, ".claude", "settings.json"), JSON.stringify({ autoMemoryEnabled: false }));
  r = doctor(b, { env, home: homeOff });
  assert.ok(!r.findings.some((f) => f.message.includes("autoMemoryEnabled")));
});
