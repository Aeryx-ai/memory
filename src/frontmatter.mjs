import YAML from "yaml";
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
export function parseDocument(text) {
  const m = FENCE.exec(text);
  if (!m) return { data: {}, body: text };
  const data = YAML.parse(m[1], { schema: "core" }) ?? {};
  return { data, body: text.slice(m[0].length) };
}
export function renderDocument(data, body) {
  const yaml = YAML.stringify(data, { lineWidth: 0, schema: "core" }).trimEnd();
  return `---\n${yaml}\n---\n${body.endsWith("\n") || body === "" ? body : body + "\n"}`;
}
