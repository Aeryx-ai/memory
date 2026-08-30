import { MemoryError } from "./errors.mjs";
import { TYPES, legalTypes } from "./types.mjs";
import { parseActor } from "./actor.mjs";
import { findSecret } from "./secrets.mjs";
import { parseDocument, renderDocument } from "./frontmatter.mjs";

const KNOWN = ["type", "title", "description", "tags", "status", "generated", "verified", "sources", "stale_after"];
const STATUSES = ["draft", "stable", "deprecated"];

function checkText(field, text) {
  const hit = findSecret(String(text ?? ""));
  if (hit) throw new MemoryError("refused", `secret (${hit.name}) in ${field}; nothing written`);
}
function checkSources(sources) {
  const seen = new Set();
  for (const s of sources) {
    if (!s || typeof s.resource !== "string" || !s.resource) throw new MemoryError("refused", "source needs a resource");
    if (seen.has(s.resource)) throw new MemoryError("refused", `duplicate source ${s.resource}`);
    seen.add(s.resource);
  }
}
function finish(c) {
  if (!TYPES.includes(c.type)) throw new MemoryError("refused", `type ${JSON.stringify(c.type)} not in ${TYPES.join(", ")}`);
  if (!String(c.title ?? "").trim()) throw new MemoryError("refused", "title is empty");
  if (!STATUSES.includes(c.status)) throw new MemoryError("refused", `status ${c.status}`);
  parseActor(c.generated?.by);
  if (typeof c.generated?.at !== "string") throw new MemoryError("refused", "generated.at missing");
  for (const v of c.verified) parseActor(v.by);
  checkSources(c.sources);
  checkText("title", c.title); checkText("description", c.description); checkText("body", c.body);
  return Object.freeze(c);
}
export function createConcept({ type, title, description = "", tags = [], status = "stable", actor, at = new Date().toISOString(), sources = [], body = "", verified = [], stale_after, extra = {} }) {
  return finish({ type, title: String(title).trim(), description: String(description).trim(), tags: [...tags], status, generated: { by: actor, at }, verified: [...verified], sources: sources.map((s) => ({ ...s })), ...(stale_after ? { stale_after } : {}), body, extra: { ...extra } });
}
export function parseConcept(text) {
  const { data, body } = parseDocument(text);
  if (!data.type) throw new MemoryError("refused", "concept has no type");
  const extra = Object.fromEntries(Object.entries(data).filter(([k]) => !KNOWN.includes(k)));
  const verified = data.verified == null ? [] : Array.isArray(data.verified) ? data.verified : [data.verified];
  return finish({ type: data.type, title: String(data.title ?? "").trim(), description: String(data.description ?? "").trim(), tags: data.tags ?? [], status: data.status ?? "stable", generated: data.generated ?? {}, verified, sources: data.sources ?? [], ...(data.stale_after ? { stale_after: data.stale_after } : {}), body, extra });
}
export function renderConcept(c) {
  const data = { type: c.type, title: c.title };
  if (c.description) data.description = c.description;
  if (c.tags.length) data.tags = c.tags;
  data.status = c.status;
  data.generated = c.generated;
  if (c.verified.length) data.verified = c.verified;
  if (c.sources.length) data.sources = c.sources;
  if (c.stale_after) data.stale_after = c.stale_after;
  Object.assign(data, c.extra);
  return renderDocument(data, c.body);
}
export function validateConcept(c, { isRoot }) {
  finish({ ...c });
  if (!legalTypes(isRoot).includes(c.type)) throw new MemoryError("refused", `${c.type} is not allowed at the ${isRoot ? "bundle root" : "project directory"}`);
}
function stamp(c, actor, at) { parseActor(actor); return { ...c, generated: { by: actor, at } }; }
export function deprecate(c, actor, at) {
  if (c.status === "deprecated") throw new MemoryError("refused", `${c.title} is already deprecated`);
  return finish({ ...stamp(c, actor, at), status: "deprecated" });
}
export function restore(c, actor, at) {
  if (c.status === "stable") throw new MemoryError("refused", `${c.title} is already stable`);
  return finish({ ...stamp(c, actor, at), status: "stable" });
}
export function revise(c, fields, actor, at) {
  const next = { ...stamp(c, actor, at) };
  for (const k of ["title", "description", "body", "tags"]) if (fields[k] !== undefined) next[k] = fields[k];
  if (fields.sources) {
    const have = new Set(c.sources.map((s) => s.resource));
    next.sources = [...c.sources, ...fields.sources.filter((s) => !have.has(s.resource))];
  }
  if (fields.status) next.status = fields.status;
  return finish(next);
}
