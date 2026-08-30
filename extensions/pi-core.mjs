import fs from "node:fs";
import path from "node:path";
import { renderContext } from "../src/context.mjs";
import { parseSummaryBody } from "../src/summary.mjs";
import { projectIdFor } from "../src/project-id.mjs";
const NOTE = `Tools: memory_remember saves a durable concept (User, Feedback, Project, Reference); memory_recall searches; memory_deprecate retires one; memory_recall_observation expands a [id] line from a session summary.\n`;
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } }
export function readSettings(agentDir, cwd) {
  return { ...(readJson(path.join(agentDir, "settings.json")).memory ?? {}), ...(readJson(path.join(cwd, ".pi", "settings.json")).memory ?? {}) };
}
export function contextBlock(bundle, cwd, session) {
  return renderContext(bundle, { projectId: projectIdFor(cwd), session }) + NOTE;
}
export function compactionFromSummary(bundle, projectId, session, preparation) {
  const dir = bundle.dir(projectId);
  const hit = bundle.listConcepts(dir).find((e) => e.concept.type === "Session Summary" && e.concept.sources.some((s) => s.resource === session));
  if (!hit) return null;
  const { reflections, observations } = parseSummaryBody(hit.concept.body);
  const summary = `These are condensed memories from earlier in this session. Reflections are durable facts; observations are timestamped events, newest last. Use memory_recall_observation with an id when the exact source matters.\n\n## Reflections\n${reflections.map((r) => `[${r.id}] ${r.content}`).join("\n")}\n\n## Observations\n${observations.map((o) => `[${o.id}] ${o.at} [${o.relevance}] ${o.content}`).join("\n")}\n`;
  return { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, details: { source: hit.rel } };
}
export function summarizeCmd(settings, model) {
  const m = settings.summaryModel ?? `${model.provider}/${model.id}`;
  return `pi -p --no-extensions --no-skills --model ${m} "$(cat "$MEMORY_PROMPT_FILE")"`;
}
