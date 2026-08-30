import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryError } from "../errors.mjs";
import { createConcept, revise, validateConcept } from "../concept.mjs";
import { slugify } from "../slug.mjs";
import { projectIdFor, localProjectId } from "../project-id.mjs";
import { appendLog } from "../log-file.mjs";
import { writeIndex } from "../index-file.mjs";
import { withLock, commitAll } from "../git.mjs";
import * as claude from "./claude.mjs";
import * as hermes from "./hermes.mjs";
import * as piMemory from "./pi-memory.mjs";
import * as codex from "./codex.mjs";

const STORES = { claude, hermes, "pi-memory": piMemory, codex };

// A Claude project-memory directory name is the project's absolute path with
// every "/" turned into "-" (and the leading "/" becoming a leading "-"), so
// a dash in the slug is ambiguous: it could be a path separator or a literal
// dash inside a directory name; a real directory can also carry a literal dot
// or space (e.g. "grigsby.dev", "Just Next"), which Claude's own slugifier
// collapses to "-" the same way. Resolve it by exploring, left to right,
// every way of grouping the dash-split parts into path segments, only
// descending into a segment once it is confirmed to exist on disk; the first
// full-length candidate that exists wins.
const SEGMENT_JOINERS = [".", " ", "-"];
export function decodeClaudeSlug(slug, exists = fs.existsSync) {
  const parts = slug.replace(/^-/, "").split("-");
  const join = (base, segment) => (base === "" ? `/${segment}` : `${base}/${segment}`);
  function walk(committed, segment, i) {
    if (i === parts.length) {
      const full = join(committed, segment);
      return exists(full) ? full : null;
    }
    const closed = join(committed, segment);
    if (exists(closed)) {
      const viaNewSegment = walk(closed, parts[i], i + 1);
      if (viaNewSegment) return viaNewSegment;
    }
    for (const joiner of SEGMENT_JOINERS) {
      const viaExtendedSegment = walk(committed, `${segment}${joiner}${parts[i]}`, i + 1);
      if (viaExtendedSegment) return viaExtendedSegment;
    }
    return null;
  }
  if (!parts.length || parts[0] === "") return null;
  return walk("", parts[0], 1);
}

export function projectIdForPath(p) { return fs.existsSync(p) ? projectIdFor(p) : localProjectId(p); }

export function resolveProjectName(name, projectsRoot) {
  const p = path.join(projectsRoot, name);
  return fs.existsSync(p) ? projectIdFor(p) : `local/${name}`;
}

// Rewrite [[slug]] references to a markdown link once the item that slug
// names has actually been written into the same bundle directory; slugs maps
// a bare filename slug to its path relative to that directory.
export function wikiToLinks(body, slugs) {
  return body.replace(/\[\[([^\]]+)\]\]/g, (m, s) => (slugs.has(s) ? `[${s}](${slugs.get(s)})` : m));
}

export function migrate(bundle, store, { home = os.homedir(), projectsRoot = path.join(home, "projects"), dryRun = false } = {}) {
  const stores = store === "all" ? Object.keys(STORES) : [store];
  const result = { store, created: 0, updated: 0, skipped: 0, refused: 0, report: [] };
  const touched = new Set();
  // Rels this run has already committed to creating, even though dryRun means
  // nothing has actually landed on disk yet; without this a second colliding
  // item in the same dry run would compute the same rel as the first instead
  // of previewing the "-2" suffix a real run would give it.
  const planned = new Set();
  for (const name of stores) {
    if (!STORES[name]) throw new Error(`unknown store ${name}`);
    const { items, report } = STORES[name].plan({ home, projectsRoot });
    result.report.push(...report);
    const actor = `process:migrate-${name}`;
    for (const item of items) {
      const dir = bundle.dir(item.projectId);
      const existing = bundle.listConcepts(dir).find((e) => e.concept.sources.some((s) => s.resource === item.sourceResource));
      if (existing) {
        const src = existing.concept.sources.find((s) => s.resource === item.sourceResource);
        if ((src.last_modified ?? "") >= item.lastModified) { result.skipped++; continue; }
        let next;
        try {
          next = revise(
            { ...existing.concept, sources: existing.concept.sources.map((s) => (s === src ? { ...s, last_modified: item.lastModified } : s)) },
            { body: item.body, description: item.description, tags: item.tags },
            actor, item.at,
          );
        } catch (e) {
          if (e instanceof MemoryError && e.code === "refused") {
            result.refused++; result.report.push(`skip ${existing.rel}: ${e.message}`);
            continue;
          }
          throw e;
        }
        result.updated++; result.report.push(`update ${existing.rel}`);
        if (dryRun) continue;
        bundle.writeConcept(existing.rel, next);
        appendLog(bundle, dir, { kind: "Update", concept: next, rel: existing.rel, actor, at: item.at });
        touched.add(dir.rel);
        continue;
      }
      const slug = slugify(item.title);
      let rel = bundle.conceptRel(dir, item.type, slug);
      for (let n = 2; bundle.read(rel) != null || planned.has(rel); n++) rel = bundle.conceptRel(dir, item.type, `${slug}-${n}`);
      let concept;
      try {
        concept = createConcept({
          type: item.type, title: item.title, description: item.description, tags: item.tags ?? [],
          actor, at: item.at, sources: [{ resource: item.sourceResource, last_modified: item.lastModified }], body: item.body,
        });
        validateConcept(concept, { isRoot: dir.isRoot });
      } catch (e) {
        if (e instanceof MemoryError && e.code === "refused") {
          result.refused++; result.report.push(`skip ${rel}: ${e.message}`);
          continue;
        }
        throw e;
      }
      planned.add(rel);
      result.created++; result.report.push(`create ${rel}`);
      if (dryRun) continue;
      bundle.writeConcept(rel, concept);
      appendLog(bundle, dir, { kind: "Creation", concept, rel, actor, at: item.at });
      touched.add(dir.rel);
    }
  }
  if (!dryRun) {
    const ran = withLock(bundle.root, () => {
      for (const rel of touched) {
        const dir = rel ? bundle.dir(rel.replace(/^projects\//, "")) : bundle.dir(null);
        const slugs = new Map(bundle.listConcepts(dir).map((e) => [path.basename(e.rel, ".md"), path.posix.relative(dir.rel, e.rel)]));
        for (const e of bundle.listConcepts(dir)) {
          const body = wikiToLinks(e.concept.body, slugs);
          if (body !== e.concept.body) bundle.writeConcept(e.rel, { ...e.concept, body });
        }
        writeIndex(bundle, dir);
      }
      commitAll(bundle.root, `memory: migrate ${store}`);
    });
    result.committed = ran;
    if (!ran) result.report.push("lock held; rerun to commit");
  }
  return result;
}
