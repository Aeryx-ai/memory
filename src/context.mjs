import path from "node:path";
import { parseDocument } from "./frontmatter.mjs";
export function renderContext(bundle, { projectId, session, summaries = 3, budget }) {
  const rootIndex = indexBody(bundle, "index.md");
  const proj = bundle.dir(projectId);
  const projIndex = indexBody(bundle, path.posix.join(proj.rel, "index.md")) || "No concepts yet.\n";
  let sums = bundle.listConcepts(proj).filter((e) => e.concept.type === "Session Summary" && e.concept.status !== "deprecated")
    .sort((a, b) => b.concept.generated.at.localeCompare(a.concept.generated.at));
  const own = session ? sums.find((e) => e.concept.sources.some((s) => s.resource === session)) : null;
  sums = (own ? [own, ...sums.filter((e) => e !== own)] : sums).slice(0, summaries);
  const head = `<memory-context bundle="${bundle.root}" project="${projectId}">\n## Bundle\n${rootIndex}\n## Project ${projectId}\n${projIndex}\n## Session summaries\n`;
  const tail = `</memory-context>\n`;
  let blocks = sums.map((e) => `### ${e.concept.title}\n${e.concept.body.trimEnd()}\n\n`);
  if (budget) {
    while (blocks.length && Buffer.byteLength(head + blocks.join("") + tail) > budget) {
      if (blocks.length > 1) blocks.pop();
      else { const room = budget - Buffer.byteLength(head + tail) - 12; blocks[0] = blocks[0].slice(0, Math.max(0, room)) + "[truncated]\n"; break; }
    }
  }
  return head + blocks.join("") + tail;
}
function indexBody(bundle, rel) { const t = bundle.read(rel); return t == null ? "" : parseDocument(t).body; }
