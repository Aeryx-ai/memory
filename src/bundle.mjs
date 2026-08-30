import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { MemoryError } from "./errors.mjs";
import { TYPE_DIRS, dirForType } from "./types.mjs";
import { parseConcept, renderConcept } from "./concept.mjs";
import { assertProjectId } from "./project-id.mjs";

const ROOT_INDEX = `---\nokf_version: "0.2"\n---\n`;
export class Bundle {
  static resolveRoot({ dir, env = process.env } = {}) {
    if (dir) return path.resolve(dir);
    if (env.MEMORY_DIR) return path.resolve(env.MEMORY_DIR);
    return path.join(env.HOME ?? os.homedir(), ".agents", "memory");
  }
  constructor(root) { this.root = path.resolve(root); }
  abs(rel) { return path.join(this.root, rel); }
  exists() { return fs.existsSync(this.abs("index.md")); }
  init({ remote, at } = {}) {
    fs.mkdirSync(this.root, { recursive: true });
    if (!fs.existsSync(this.abs(".gitignore"))) this.writeAtomic(".gitignore", ".state/\n.locks/\n");
    if (!fs.existsSync(this.abs("index.md"))) this.writeAtomic("index.md", ROOT_INDEX);
    if (!fs.existsSync(this.abs("log.md"))) {
      const d = (at ?? new Date().toISOString()).slice(0, 10);
      this.writeAtomic("log.md", `# Directory Update Log\n\n## ${d}\n* **Initialization**: Created the memory bundle.\n`);
    }
    if (!fs.existsSync(this.abs(".git"))) execFileSync("git", ["init", "-q", "-b", "main"], { cwd: this.root });
    if (remote) {
      try { execFileSync("git", ["remote", "get-url", "origin"], { cwd: this.root, stdio: "ignore" }); }
      catch { execFileSync("git", ["remote", "add", "origin", remote], { cwd: this.root }); }
    }
  }
  dir(projectId) {
    if (projectId == null) return { rel: "", abs: this.root, isRoot: true, projectId: null };
    assertProjectId(projectId);
    const rel = path.posix.join("projects", projectId);
    return { rel, abs: this.abs(rel), isRoot: false, projectId };
  }
  dirs() {
    const out = [this.dir(null)];
    const projects = this.abs("projects");
    if (!fs.existsSync(projects)) return out;
    const typeDirs = new Set(Object.values(TYPE_DIRS));
    const walk = (abs, rel) => {
      const names = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      if (names.some((n) => typeDirs.has(n)) || fs.existsSync(path.join(abs, "index.md"))) { out.push(this.dir(rel)); return; }
      for (const n of names) walk(path.join(abs, n), path.posix.join(rel, n));
    };
    for (const d of fs.readdirSync(projects, { withFileTypes: true })) {
      if (d.isDirectory()) walk(path.join(projects, d.name), d.name);
    }
    // root's rel is "" so it sorts first alongside the rest; filesystem order is not guaranteed.
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }
  conceptRel(dir, type, slug) { return path.posix.join(dir.rel, dirForType(type), `${slug}.md`); }
  writeAtomic(rel, text) {
    const abs = this.abs(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, abs);
  }
  read(rel) { try { return fs.readFileSync(this.abs(rel), "utf8"); } catch { return null; } }
  writeConcept(rel, concept) { this.writeAtomic(rel, renderConcept(concept)); }
  readConcept(rel) {
    const text = this.read(rel);
    if (text == null) throw new MemoryError("notfound", rel);
    return parseConcept(text);
  }
  listConcepts(dir) {
    const out = [];
    for (const typeDir of Object.values(TYPE_DIRS)) {
      const abs = path.join(dir.abs, typeDir);
      if (!fs.existsSync(abs)) continue;
      for (const name of fs.readdirSync(abs)) {
        if (!name.endsWith(".md")) continue;
        const rel = path.posix.join(dir.rel, typeDir, name);
        try { out.push({ rel, concept: parseConcept(this.read(rel)) }); } catch { /* check reports it */ }
      }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }
  findConcept(dir, key) {
    const entries = this.listConcepts(dir);
    const exact = entries.find((e) => e.rel === key || path.posix.relative(dir.rel, e.rel) === key);
    if (exact) return exact;
    const bare = entries.filter((e) => e.rel.endsWith(`/${key}.md`) || e.rel === `${key}.md`);
    if (bare.length > 1) throw new MemoryError("refused", `ambiguous key ${key}: ${bare.map((e) => path.posix.relative(dir.rel, e.rel)).join(", ")}`);
    if (bare.length === 1) return bare[0];
    throw new MemoryError("notfound", `no concept ${key} in ${dir.rel || "bundle root"}`);
  }
  statePath(name) { fs.mkdirSync(this.abs(".state"), { recursive: true }); return this.abs(path.posix.join(".state", name)); }
}
