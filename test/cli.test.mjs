import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { main } from "../src/cli.mjs";
import { tmpBundle, tmpGitRepo, tmpDir } from "./helpers.mjs";
process.env.MEMORY_SYNC_INLINE = "1";
async function run(args, { stdin = "" } = {}) {
  let out = "", err = "";
  const w = process.stdout.write, e = process.stderr.write;
  process.stdout.write = (s) => { out += s; return true; }; process.stderr.write = (s) => { err += s; return true; };
  const code = await main([...args, "--stdin-text", stdin]).finally(() => { process.stdout.write = w; process.stderr.write = e; });
  let json = null; if (out) { try { json = JSON.parse(out); } catch { /* markdown output, e.g. --md */ } }
  return { code, out, err, json };
}
test("remember creates, revises by slug, refuses secrets, and the job updates index and commits", async () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const base = ["--dir", b.root, "--cwd", repo, "--actor", "pi/kimi-k3"];
  let r = await run([...base, "remember", "--type", "Project", "--title", "Cut over", "--description", "d", "--source", "pi:session/1"], { stdin: "Body.\n" });
  assert.equal(r.code, 0); assert.deepEqual(r.json, { rel: "projects/github.com/a/b/project/cut-over.md", created: true });
  assert.match(b.read("projects/github.com/a/b/index.md"), /\[Cut over\]\(project\/cut-over\.md\) - d/);
  assert.match(b.read("projects/github.com/a/b/log.md"), /\*\*Creation\*\*: \[Cut over\]/);
  assert.match(fs.readFileSync(path.join(b.root, ".git", "logs", "HEAD"), "utf8"), /memory: remember Cut over/);
  r = await run([...base, "remember", "--type", "Project", "--title", "Cut over"], { stdin: "Body 2.\n" });
  assert.deepEqual(r.json, { rel: "projects/github.com/a/b/project/cut-over.md", created: false });
  assert.equal(b.readConcept(r.json.rel).body, "Body 2.\n");
  r = await run([...base, "remember", "--type", "Project", "--title", "Leak"], { stdin: "AKIAIOSFODNN7EXAMPLE\n" });
  assert.equal(r.code, 3); assert.match(r.err, /secret/); assert.equal(b.read("projects/github.com/a/b/project/leak.md"), null);
  r = await run([...base, "remember", "--type", "User", "--title", "Me"], { stdin: "x" });
  assert.equal(r.code, 3);
  r = await run([...base, "remember", "--root", "--type", "User", "--title", "Me"], { stdin: "x" });
  assert.equal(r.json.rel, "user/me.md");
});
test("deprecate, restore, show, project-id, usage errors", async () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const base = ["--dir", b.root, "--cwd", repo];
  await run([...base, "remember", "--type", "Feedback", "--title", "Rule"], { stdin: "x" });
  let r = await run([...base, "deprecate", "rule"]); assert.deepEqual(r.json, { rel: "projects/github.com/a/b/feedback/rule.md", status: "deprecated" });
  assert.doesNotMatch(b.read("projects/github.com/a/b/index.md") ?? "", /Rule/);
  r = await run([...base, "restore", "rule"]); assert.equal(r.json.status, "stable");
  r = await run([...base, "show", "rule"]); assert.equal(r.json.title, "Rule"); assert.equal(r.json.generated.by, `human:${process.env.USER}`);
  r = await run([...base, "show", "rule", "--md"]); assert.match(r.out, /^---\ntype: Feedback/);
  r = await run([...base, "show", "nope"]); assert.equal(r.code, 2);
  r = await run([...base, "project-id"]); assert.deepEqual(r.json, { projectId: "github.com/a/b" });
  r = await run([...base, "remember", "--title", "no type"]); assert.equal(r.code, 1);
  r = await run([...base, "bogus"]); assert.equal(r.code, 1);
});
test("remember refuses to overwrite a concept that fails to parse", async () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const base = ["--dir", b.root, "--cwd", repo];
  const rel = "projects/github.com/a/b/project/broken.md";
  b.writeAtomic(rel, "no frontmatter here\n");
  const r = await run([...base, "remember", "--type", "Project", "--title", "Broken"], { stdin: "new body\n" });
  assert.equal(r.code, 3);
  assert.equal(b.read(rel), "no frontmatter here\n");
});
test("global flags accept --flag=value form", async () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const r = await run(["--dir=" + b.root, "--cwd=" + repo, "project-id"]);
  assert.deepEqual(r.json, { projectId: "github.com/a/b" });
});
test("init is idempotent and sets the remote", async () => {
  const root = path.join(tmpBundle().root, "..", "fresh");
  let r = await run(["--dir", root, "init", "--remote", "git@github.com:guygrigsby/agent-memory.git"]);
  assert.deepEqual(r.json, { root });
  r = await run(["--dir", root, "init"]); assert.equal(r.code, 0);
});
test("context includes the project index", async () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const base = ["--dir", b.root, "--cwd", repo];
  await run([...base, "remember", "--type", "Project", "--title", "Goal", "--description", "the goal"], { stdin: "x" });
  const r = await run([...base, "context"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /## Project github\.com\/a\/b\n# Project\n\n\* \[Goal\]\(project\/goal\.md\) - the goal\n/);
});
test("recall --md renders a markdown list", async () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const base = ["--dir", b.root, "--cwd", repo];
  await run([...base, "remember", "--type", "Feedback", "--title", "Telegram rule", "--description", "reminders"], { stdin: "x" });
  const r = await run([...base, "recall", "--md", "telegram"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^\* \[Telegram rule\]\(projects\/github\.com\/a\/b\/feedback\/telegram-rule\.md\) - reminders \(Feedback, 3\)\n$/);
});
test("check exit 4 after corrupting a directory index; index repairs it and check passes", async () => {
  const b = tmpBundle(); const repo = tmpGitRepo("git@github.com:a/b.git");
  const base = ["--dir", b.root, "--cwd", repo];
  await run([...base, "remember", "--type", "Feedback", "--title", "Rule"], { stdin: "x" });
  let r = await run([...base, "check"]);
  assert.equal(r.code, 0); assert.deepEqual(r.json, { ok: true, problems: [] });
  fs.writeFileSync(path.join(b.root, "projects", "github.com", "a", "b", "index.md"), "stale\n");
  r = await run([...base, "check"]);
  assert.equal(r.code, 4);
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.problems.map((p) => p.rel), ["projects/github.com/a/b/index.md"]);
  r = await run([...base, "index"]);
  assert.equal(r.code, 0);
  assert.ok(r.json.dirs >= 2);
  r = await run([...base, "check"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { ok: true, problems: [] });
});
test("sync without a remote reports no pull or push", async () => {
  const b = tmpBundle();
  const r = await run(["--dir", b.root, "sync"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { pulled: false, pushed: false, conflict: false });
});
test("sync pulls a concept pushed from elsewhere and pushes the regenerated index back", async () => {
  const b = tmpBundle();
  const bare = tmpDir("bare-");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: b.root });
  let r = await run(["--dir", b.root, "sync", "--push"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.pushed, true);

  // a second clone commits and pushes a new concept directly, bypassing this bundle
  const clone = tmpDir("clone-");
  execFileSync("git", ["clone", "-q", bare, clone]);
  fs.mkdirSync(path.join(clone, "feedback"), { recursive: true });
  fs.writeFileSync(path.join(clone, "feedback", "x.md"), "---\ntype: Feedback\ntitle: X\nstatus: stable\ngenerated: { by: human:guy, at: 2026-08-03T00:00:00Z }\n---\n");
  execFileSync("git", ["add", "-A"], { cwd: clone });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "add x"], { cwd: clone });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: clone });

  r = await run(["--dir", b.root, "sync"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { pulled: true, pushed: true, conflict: false });
  assert.match(b.read("index.md"), /\[X\]\(feedback\/x\.md\)/);
});
test("doctor exit code with a temp HOME", async () => {
  const b = tmpBundle();
  const home = tmpDir("home-");
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const r = await run(["--dir", b.root, "doctor"]);
    assert.equal(r.code, 0);
    const msgs = r.json.findings.map((f) => f.message);
    assert.ok(msgs.some((m) => m.startsWith("bundle ")));
    assert.ok(msgs.includes("no git remote; memory stays on this machine (memory init --remote URL)"));
    assert.ok(msgs.includes("check clean"));
  } finally { process.env.HOME = prevHome; }
});
