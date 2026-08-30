import { randomBytes } from "node:crypto";
export const RELEVANCE = ["low", "medium", "high", "critical"];
const OBS = /^\[([a-f0-9]{12})\] (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \[(low|medium|high|critical)\] (.+)$/;
const REF = /^\[([a-f0-9]{12})\] (.+?)(?: <- ([a-f0-9]{12}(?:,[a-f0-9]{12})*))?$/;
export function newId() { return randomBytes(6).toString("hex"); }
export function estimateTokens(text) { return Math.ceil(Buffer.byteLength(text) / 4); }
export function parseSummaryBody(body) {
  const out = { reflections: [], observations: [] };
  let section = null;
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (line === "# Reflections") { section = "r"; continue; }
    if (line === "# Observations") { section = "o"; continue; }
    if (!line || !section) continue;
    if (section === "o") { const m = OBS.exec(line); if (m) out.observations.push({ id: m[1], at: m[2], relevance: m[3], content: m[4] }); }
    else { const m = REF.exec(line); if (m) out.reflections.push({ id: m[1], content: m[2], supports: m[3] ? m[3].split(",") : [] }); }
  }
  return out;
}
export function renderSummaryBody({ reflections, observations }) {
  const r = reflections.map((x) => `[${x.id}] ${x.content}${x.supports.length ? ` <- ${x.supports.join(",")}` : ""}`);
  const o = observations.map((x) => `[${x.id}] ${x.at} [${x.relevance}] ${x.content}`);
  return `# Reflections\n${r.map((l) => l + "\n").join("")}\n# Observations\n${o.map((l) => l + "\n").join("")}`;
}
const obsLine = (o) => `[${o.id}] ${o.at} [${o.relevance}] ${o.content}\n`;
export function pruneObservations({ observations, reflections, maxTokens, targetTokens }) {
  const tokens = (list) => estimateTokens(list.map(obsLine).join(""));
  if (tokens(observations) <= maxTokens) return { observations, dropped: [] };
  const covered = new Set(reflections.flatMap((r) => r.supports));
  const dropped = [];
  let live = [...observations];
  const dropFirst = (pred) => { const i = live.findIndex(pred); if (i < 0) return false; dropped.push(live[i].id); live.splice(i, 1); return true; };
  while (tokens(live) > targetTokens && dropFirst((o) => covered.has(o.id))) { /* covered, oldest first */ }
  for (const level of RELEVANCE) while (tokens(live) > targetTokens && dropFirst((o) => o.relevance === level)) { /* lowest relevance, oldest first */ }
  return { observations: live, dropped };
}
