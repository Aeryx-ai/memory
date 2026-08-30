import fs from "node:fs";
import path from "node:path";
import { parseConcept, validateConcept } from "./concept.mjs";
import { renderIndex } from "./index-file.mjs";
import { TYPE_DIRS } from "./types.mjs";
export function check(bundle) {
  const problems = [];
  for (const dir of bundle.dirs()) {
    const entries = [];
    for (const typeDir of Object.values(TYPE_DIRS)) {
      const abs = path.join(dir.abs, typeDir); if (!fs.existsSync(abs)) continue;
      for (const name of fs.readdirSync(abs).filter((n) => n.endsWith(".md"))) {
        const rel = path.posix.join(dir.rel, typeDir, name);
        try { const concept = parseConcept(bundle.read(rel)); validateConcept(concept, { isRoot: dir.isRoot }); entries.push({ rel, concept }); }
        catch (e) { problems.push({ rel, problem: e.message }); }
      }
    }
    entries.dirRel = dir.rel;
    const indexRel = path.posix.join(dir.rel, "index.md");
    const expected = renderIndex(entries, { isRoot: dir.isRoot });
    const actual = bundle.read(indexRel);
    if (actual !== expected) problems.push({ rel: indexRel, problem: actual == null ? "missing index" : "index differs from regeneration" });
  }
  return { ok: problems.length === 0, problems };
}
