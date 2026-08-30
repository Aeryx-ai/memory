import fs from "node:fs";
import path from "node:path";
import { resolveProjectName } from "./index.mjs";

const META = /<!--\s*created=(\d{4}-\d{2}-\d{2}),\s*last=(\d{4}-\d{2}-\d{2})\s*-->/;

export function splitEntries(text) {
  return text.split(/\n?§\n?/).map((s) => s.trim()).filter(Boolean).map((raw) => {
    const m = META.exec(raw);
    const content = raw.replace(META, "").trim();
    return { content, created: m ? `${m[1]}T00:00:00Z` : null, last: m ? `${m[2]}T00:00:00Z` : null };
  });
}

export function titleFor(content) {
  const first = content.split(/[.:;!?\n]/)[0].trim();
  return (first.length > 70 ? `${first.slice(0, 67)}...` : first) || content.slice(0, 40);
}

export function plan({ home, projectsRoot }) {
  const items = [], report = [];
  const root = path.join(home, ".pi", "agent", "pi-hermes-memory");
  const files = [["MEMORY.md", "Feedback"], ["USER.md", "User"], ["failures.md", "Feedback"]];
  for (const [name, type] of files) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const mtime = fs.statSync(file).mtime.toISOString();
    splitEntries(fs.readFileSync(file, "utf8")).forEach((e, i) => items.push({
      projectId: null, type, title: titleFor(e.content),
      description: e.content.slice(0, 200).replace(/\s+/g, " "),
      tags: name === "failures.md" ? ["failure"] : [],
      body: `${e.content}\n`,
      sourceResource: `file://${file}#${i}`,
      lastModified: e.last ?? mtime, at: e.created ?? mtime,
    }));
  }
  if (fs.existsSync(path.join(root, "skills"))) report.push(`hermes: ${path.join(root, "skills")} holds skills, not memory; skills/ not imported`);
  const projects = path.join(home, ".pi", "agent", "projects-memory");
  if (fs.existsSync(projects)) {
    for (const name of fs.readdirSync(projects)) {
      const file = path.join(projects, name, "MEMORY.md");
      if (!fs.existsSync(file)) continue;
      const projectId = resolveProjectName(name, projectsRoot);
      const mtime = fs.statSync(file).mtime.toISOString();
      splitEntries(fs.readFileSync(file, "utf8")).forEach((e, i) => items.push({
        projectId, type: "Project", title: titleFor(e.content),
        description: e.content.slice(0, 200).replace(/\s+/g, " "),
        tags: [],
        body: `${e.content}\n`,
        sourceResource: `file://${file}#${i}`,
        lastModified: e.last ?? mtime, at: e.created ?? mtime,
      }));
    }
  }
  return { items, report };
}
