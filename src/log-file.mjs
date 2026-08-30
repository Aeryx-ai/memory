import path from "node:path";

const HEADER = "# Directory Update Log\n";
const HEADING_RE = /^## (\d{4}-\d{2}-\d{2})\n/gm;

export function appendLog(bundle, dir, { kind, concept, rel, actor, at }) {
  const logRel = path.posix.join(dir.rel, "log.md");
  const day = at.slice(0, 10);
  const link = dir.rel ? path.posix.relative(dir.rel, rel) : rel;
  const line = `* **${kind}**: [${concept.title}](${link}) by ${actor}`;
  const blocks = parseBlocks(bundle.read(logRel) ?? HEADER);
  const existing = blocks.find((b) => b.date === day);
  if (existing) existing.lines.push(line);
  else {
    const before = blocks.findIndex((b) => b.date < day);
    blocks.splice(before < 0 ? blocks.length : before, 0, { date: day, lines: [line] });
  }
  bundle.writeAtomic(logRel, render(blocks));
}

// Parse the "## date" blocks out of a log, in whatever order they appear.
function parseBlocks(text) {
  const matches = [...text.matchAll(HEADING_RE)];
  return matches.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const lines = text.slice(start, end).split("\n").filter((l) => l.length > 0);
    return { date: m[1], lines };
  });
}

// Re-render blocks in whatever order they're given; callers keep them sorted newest first.
function render(blocks) {
  return HEADER + "\n" + blocks.map((b) => `## ${b.date}\n${b.lines.join("\n")}\n`).join("\n");
}
