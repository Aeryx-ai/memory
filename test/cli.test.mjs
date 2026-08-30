import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../src/cli.mjs";
import { tmpBundle, tmpGitRepo } from "./helpers.mjs";
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
