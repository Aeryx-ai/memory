import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "../frontmatter.mjs";
import { assertProjectId } from "../project-id.mjs";
import { decodeClaudeSlug, projectIdForPath } from "./index.mjs";

const TYPES = { user: "User", feedback: "Feedback", project: "Project", reference: "Reference" };

// decodeClaudeSlug couldn't confirm a path exists on disk (moved, deleted, or
// a different machine): fall back to a local id derived from the slug text
// itself. A bare "last dash-separated word" collapses distinct projects that
// share a tail ("projects-talon" and "projects-guygrigsby-talon" both become
// "local/talon"); instead strip the leading "-Users-<user>-" home-directory
// segment (Claude's slug always starts there) and an optional "projects-"
// after it, keeping the rest of the dash-joined tail intact. A doubled dash
// from a leading-dot directory (".config" slugified inside a path becomes
// "--config") collapses the same way a single dash would.
export function fallbackLocalProjectId(slug) {
  const lastSegment = slug.split("-").pop();
  const m = /^-Users-[^-]+-(.*)$/.exec(slug);
  if (!m) return assertProjectId(`local/${lastSegment}`);
  const tail = m[1].replace(/^projects-/, "").replace(/^-+/, "");
  return assertProjectId(`local/${tail || lastSegment}`);
}

export function plan({ home }) {
  const items = [], report = [];
  const root = path.join(home, ".claude", "projects");
  if (!fs.existsSync(root)) return { items, report: ["claude: no ~/.claude/projects"] };
  for (const slug of fs.readdirSync(root)) {
    const mem = path.join(root, slug, "memory");
    if (!fs.existsSync(mem)) continue;
    const decoded = decodeClaudeSlug(slug);
    const projectId = decoded ? projectIdForPath(decoded) : fallbackLocalProjectId(slug);
    if (!decoded) report.push(`claude: ${slug} does not resolve to a path; using ${projectId}`);
    for (const name of fs.readdirSync(mem).filter((n) => n.endsWith(".md") && n !== "MEMORY.md")) {
      const file = path.join(mem, name);
      let data, body;
      try { ({ data, body } = parseDocument(fs.readFileSync(file, "utf8"))); }
      catch (e) { report.push(`claude: ${file} has invalid frontmatter (${e.message.split("\n")[0]}); skipped`); continue; }
      const type = TYPES[data.metadata?.type ?? data.type] ?? "Project";
      if (type === "User") { items.push(item(null, "User", data, name, body, file)); continue; }
      items.push(item(projectId, type, data, name, body, file));
    }
  }
  return { items, report };
}

// Claude `user` facts go to the bundle root because `User` is root-only; that
// is the spec's placement rule, not a loss.
function item(projectId, type, data, name, body, file) {
  const st = fs.statSync(file);
  const lastModified = data.modified ?? st.mtime.toISOString();
  const title = data.name ? data.name.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : path.basename(name, ".md");
  return {
    projectId, type, title,
    description: String(data.description ?? "").slice(0, 300),
    tags: [],
    body: body.trim() + "\n",
    sourceResource: `file://${file}`,
    lastModified, at: lastModified,
  };
}
