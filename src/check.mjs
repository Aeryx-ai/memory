import fs from "node:fs";
import path from "node:path";
import { parseConcept, validateConcept } from "./concept.mjs";
import { renderIndex } from "./index-file.mjs";
import { TYPE_DIRS } from "./types.mjs";
export function check(bundle) {
  const problems = [];
  for (const dir of bundle.dirs()) {
    // Same set writeIndex uses, so "expected" here is exactly what `memory index`
    // would write; a placement violation still lands in entries (listConcepts
    // only parses) so it doesn't spuriously mark the index stale.
    const entries = bundle.listConcepts(dir);
    entries.dirRel = dir.rel;
    for (const typeDir of Object.values(TYPE_DIRS)) {
      const abs = path.join(dir.abs, typeDir); if (!fs.existsSync(abs)) continue;
      for (const name of fs.readdirSync(abs).filter((n) => n.endsWith(".md"))) {
        const rel = path.posix.join(dir.rel, typeDir, name);
        try { parseConcept(bundle.read(rel)); }
        catch (e) { problems.push({ rel, problem: e.message }); }
      }
    }
    for (const { rel, concept } of entries) {
      try { validateConcept(concept, { isRoot: dir.isRoot }); }
      catch (e) { problems.push({ rel, problem: e.message }); }
    }
    const indexRel = path.posix.join(dir.rel, "index.md");
    const expected = renderIndex(entries, { isRoot: dir.isRoot });
    const actual = bundle.read(indexRel);
    if (actual !== expected) problems.push({ rel: indexRel, problem: actual == null ? "missing index" : "index differs from regeneration" });
  }
  return { ok: problems.length === 0, problems };
}
