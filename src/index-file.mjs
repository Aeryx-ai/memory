import path from "node:path";
import { TYPES } from "./types.mjs";
import { compareFold } from "./compare.mjs";
export function renderIndex(entries, { isRoot }) {
  const live = entries.filter((e) => e.concept.status !== "deprecated");
  const sections = [];
  for (const type of TYPES) {
    let items = live.filter((e) => e.concept.type === type);
    if (!items.length) continue;
    items = type === "Session Summary"
      ? items.sort((a, b) => compareFold(b.concept.generated.at, a.concept.generated.at))
      : items.sort((a, b) => compareFold(a.concept.title, b.concept.title));
    const dirRel = entries.dirRel ?? "";
    const lines = items.map((e) => `* [${e.concept.title}](${relLink(dirRel, e.rel)}) - ${e.concept.description}`);
    sections.push(`# ${type}\n\n${lines.join("\n")}\n`);
  }
  return (isRoot ? `---\nokf_version: "0.2"\n---\n` : "") + sections.join("\n");
}
function relLink(dirRel, rel) { return dirRel ? path.posix.relative(dirRel, rel) : rel; }
export function writeIndex(bundle, dir) {
  const entries = bundle.listConcepts(dir);
  entries.dirRel = dir.rel;
  bundle.writeAtomic(path.posix.join(dir.rel, "index.md"), renderIndex(entries, { isRoot: dir.isRoot }));
}
