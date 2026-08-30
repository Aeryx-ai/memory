import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { migrate, decodeClaudeSlug } from "../src/migrate/index.mjs";
import { parseSummaryBody } from "../src/summary.mjs";
import { tmpBundle, tmpDir } from "./helpers.mjs";
process.env.MEMORY_SYNC_INLINE = "1";
function home() {
  const h = tmpDir("home-"); const projects = path.join(h, "projects"); const alpha = path.join(projects, "alpha");
  fs.mkdirSync(alpha, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd: alpha }); execFileSync("git", ["remote", "add", "origin", "git@github.com:t/alpha.git"], { cwd: alpha });
  const fx = path.join(import.meta.dirname, "fixtures");
  fs.cpSync(path.join(fx, "claude"), path.join(h, ".claude"), { recursive: true });
  fs.renameSync(path.join(h, ".claude", "projects", "-tmp-proj-alpha"), path.join(h, ".claude", "projects", alpha.replace(/\//g, "-")));
  fs.cpSync(path.join(fx, "hermes"), path.join(h, ".pi", "agent"), { recursive: true });
  fs.cpSync(path.join(fx, "pi-memory"), path.join(h, ".pi", "agent"), { recursive: true });
  fs.cpSync(path.join(fx, "codex"), path.join(h, ".codex"), { recursive: true });
  return { h, projects };
}
test("decodeClaudeSlug tries joins left to right", () => {
  const exists = (p) => ["/Users", "/Users/g", "/Users/g/my-app"].includes(p);
  assert.equal(decodeClaudeSlug("-Users-g-my-app", exists), "/Users/g/my-app");
  assert.equal(decodeClaudeSlug("-Users-nope-x", exists), null);
});
test("migrate all is idempotent and lands each store where the spec says", () => {
  const b = tmpBundle(); const { h, projects } = home();
  const first = migrate(b, "all", { home: h, projectsRoot: projects, dryRun: false });
  assert.equal(first.created, 10); assert.equal(first.updated, 0);
  const proj = b.dir("github.com/t/alpha");
  const names = b.listConcepts(proj).map((e) => e.rel.split("/").slice(-2).join("/")).sort();
  assert.deepEqual(names, ["feedback/reminders-via-telegram.md", "project/alpha-repo-memory.md", "project/alpha.md", "reference/secrets-from-op-cache.md"].sort());
  const tg = b.findConcept(proj, "reminders-via-telegram").concept;
  assert.match(tg.body, /\[secrets-from-op-cache\]\(reference\/secrets-from-op-cache\.md\)/);
  assert.equal(tg.generated.by, "process:migrate-claude"); assert.match(tg.sources[0].resource, /^file:\/\//);
  const rootNames = b.listConcepts(b.dir(null)).map((e) => e.rel).sort();
  // hermes MEMORY.md's secret entry (AKIAIOSFODNN7EXAMPLE) is refused, not created;
  // the entries either side of it, plus failures.md's entry that collides on title
  // with MEMORY.md's third entry, all land.
  assert.equal(first.refused, 1);
  assert.ok(first.report.some((l) => l.startsWith("skip ") && /rotate-the-leaked-key/.test(l) && /secret \(aws\)/.test(l)));
  assert.ok(rootNames.includes("feedback/reminders-via-telegram.md"));
  assert.ok(rootNames.includes("feedback/secrets-come-from-the-1password-cache-never-op-read-directly.md"));
  assert.ok(rootNames.includes("feedback/secrets-come-from-the-1password-cache-never-op-read-directly-2.md"));
  assert.equal(rootNames.filter((r) => r.startsWith("feedback/")).length, 4);
  assert.equal(rootNames.filter((r) => r.startsWith("user/")).length, 1);
  assert.equal(rootNames.filter((r) => r.startsWith("session-summaries/")).length, 1);
  const summary = b.listConcepts(b.dir(null)).find((e) => e.concept.type === "Session Summary").concept;
  assert.deepEqual(parseSummaryBody(summary.body).observations.map((o) => o.content), ["#decision [[db]] Chose Postgres."]);
  const second = migrate(b, "all", { home: h, projectsRoot: projects, dryRun: false });
  assert.deepEqual([second.created, second.updated, second.skipped], [0, 0, 10]);
  assert.equal(second.refused, 1);
  const f = path.join(h, ".codex", "memories", "alpha.md"); fs.appendFileSync(f, "- New line.\n"); const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
  const third = migrate(b, "codex", { home: h, projectsRoot: projects, dryRun: false });
  assert.equal(third.updated, 1);
  assert.equal(migrate(b, "hermes", { home: h, projectsRoot: projects, dryRun: true }).created, 0);
  assert.ok(first.report.some((l) => /skills\/ not imported/.test(l)));
});
test("dry run previews slug collisions the same way a real run would", () => {
  const b = tmpBundle(); const { h, projects } = home();
  const r = migrate(b, "hermes", { home: h, projectsRoot: projects, dryRun: true });
  assert.ok(r.report.includes("create feedback/secrets-come-from-the-1password-cache-never-op-read-directly.md"));
  assert.ok(r.report.includes("create feedback/secrets-come-from-the-1password-cache-never-op-read-directly-2.md"));
  assert.equal(b.listConcepts(b.dir(null)).length, 0);
});
