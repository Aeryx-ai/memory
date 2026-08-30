import fs from "node:fs";
import path from "node:path";
import { renderSummaryBody, newId } from "../summary.mjs";

export function plan({ home }) {
  const items = [], report = [];
  const daily = path.join(home, ".pi", "agent", "memory", "daily");
  if (!fs.existsSync(daily)) return { items, report: ["pi-memory: no daily logs"] };
  for (const name of fs.readdirSync(daily).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))) {
    const file = path.join(daily, name);
    const day = name.slice(0, 10);
    const mtime = fs.statSync(file).mtime.toISOString();
    const lines = fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("<!--") && !l.startsWith("#"));
    const observations = lines.map((l) => ({ id: newId(), at: `${day} 00:00`, relevance: "medium", content: l }));
    items.push({
      projectId: null, type: "Session Summary", title: `${day} pi-memory daily log`,
      description: `Migrated pi-memory daily log for ${day}`,
      tags: [],
      body: renderSummaryBody({ reflections: [], observations }),
      sourceResource: `file://${file}`,
      lastModified: mtime, at: `${day}T00:00:00Z`,
    });
  }
  return { items, report };
}
