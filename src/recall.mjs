import { compareFold } from "./compare.mjs";
export function recall(bundle, { projectId, type, query = "", includeDeprecated = false }) {
  const dirs = [bundle.dir(null)]; if (projectId) dirs.push(bundle.dir(projectId));
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  const out = [];
  for (const dir of dirs) for (const { rel, concept: c } of bundle.listConcepts(dir)) {
    if (!includeDeprecated && c.status === "deprecated") continue;
    if (type && c.type !== type) continue;
    let score = 0;
    for (const t of terms) {
      score += 3 * count(c.title, t) + 2 * c.tags.filter((g) => g.toLowerCase().includes(t)).length + 2 * count(c.description, t) + count(c.body, t);
    }
    if (terms.length && score === 0) continue;
    out.push({ rel, score, title: c.title, description: c.description, type: c.type, status: c.status, at: c.generated.at });
  }
  return out.sort((a, b) => b.score - a.score || compareFold(b.at, a.at)).map(({ at, ...h }) => h);
}
function count(text, term) { return text.toLowerCase().split(term).length - 1; }
