import fs from "node:fs";
import path from "node:path";
import { resolveProjectName } from "./index.mjs";

export function plan({ home, projectsRoot }) {
  const items = [], report = [];
  const dir = path.join(home, ".codex", "memories");
  if (!fs.existsSync(dir)) return { items, report: ["codex: no memories"] };
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".md"))) {
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, "utf8");
    const mtime = fs.statSync(file).mtime.toISOString();
    const base = path.basename(name, ".md").replace(/_/g, "-");
    const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? `${base} codex memory`).trim();
    items.push({
      projectId: resolveProjectName(base, projectsRoot), type: "Project", title,
      description: `Codex memory for ${base}`,
      tags: [],
      body: `${text.trim()}\n`,
      sourceResource: `file://${file}`,
      lastModified: mtime, at: mtime,
    });
  }
  return { items, report };
}
