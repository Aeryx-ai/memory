import fs from "node:fs";
export function detectFormat(p) {
  const fd = fs.openSync(p, "r"); const buf = Buffer.alloc(200); const n = fs.readSync(fd, buf, 0, 200, 0); fs.closeSync(fd);
  const head = buf.toString("utf8", 0, n);
  if (head.includes('"type":"session"')) return "pi";
  if (head.includes('"kind":"session_opened"') || head.includes('"kind":"fork_point"')) return "rudy";
  return "claude";
}
export function readDelta(p, format, fromBytes = 0) {
  const size = fs.statSync(p).size;
  if (fromBytes > size) fromBytes = 0;
  const fd = fs.openSync(p, "r"); const buf = Buffer.alloc(size - fromBytes); fs.readSync(fd, buf, 0, buf.length, fromBytes); fs.closeSync(fd);
  const text = buf.toString("utf8");
  const end = text.lastIndexOf("\n");
  const complete = end < 0 ? "" : text.slice(0, end + 1);
  const entries = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const e = format === "pi" ? fromPi(row) : format === "rudy" ? fromRudy(row) : fromClaude(row);
    if (e) entries.push(e);
  }
  return { entries, bytes: fromBytes + Buffer.byteLength(complete) };
}
const clip = (s) => (s.length > 2000 ? s.slice(0, 2000) + "…" : s);
function blocksToText(blocks, names) {
  if (typeof blocks === "string") return blocks;
  const out = [];
  for (const b of blocks ?? []) {
    if (b.type === "text" && b.text) out.push(b.text);
    else if (b.type === names.call) out.push(`call ${b.name}(${JSON.stringify(b[names.args] ?? {})})`);
    else if (b.type === names.result) out.push(`result: ${clip(typeof b.content === "string" ? b.content : blocksToText(b.content, names))}`);
  }
  return out.join("\n");
}
function fromPi(row) {
  if (row.type !== "message" || !row.message) return null;
  const m = row.message; const names = { call: "toolCall", args: "arguments", result: "toolResultNever" };
  const text = m.role === "toolResult" ? `result: ${clip(blocksToText(m.content, names))}` : blocksToText(m.content, names);
  return { id: row.id, role: m.role, at: row.timestamp, text };
}
function fromClaude(row) {
  if (row.type !== "user" && row.type !== "assistant") return null;
  const m = row.message ?? {}; const names = { call: "tool_use", args: "input", result: "tool_result" };
  const isResult = Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result");
  return { id: row.uuid, role: isResult ? "toolResult" : row.type, at: row.timestamp, text: blocksToText(m.content, names) };
}
const RUDY_NAMES = { call: "tool_use", args: "input", result: "tool_result_never" };
function fromRudy(row) {
  switch (row.kind) {
    case "user_message": return { id: row.id, role: "user", at: row.at, text: blocksToText(row.content, RUDY_NAMES) };
    case "assistant_message": return { id: row.id, role: "assistant", at: row.at, text: blocksToText(row.content, RUDY_NAMES) };
    case "tool_result": return { id: row.id, role: "toolResult", at: row.at, text: `result: ${clip(blocksToText(row.content, RUDY_NAMES))}` };
    default: return null;
  }
}
export function serializeEntries(entries) { return entries.map((e) => `--- ${e.id} ${e.role} ${e.at}\n${e.text}\n`).join(""); }
export function readEntries(p, format, ids) { const want = new Set(ids); return readDelta(p, format, 0).entries.filter((e) => want.has(e.id)); }
