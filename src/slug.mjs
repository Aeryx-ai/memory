import { MemoryError } from "./errors.mjs";
export function slugify(title) {
  const s = String(title).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
  if (!s) throw new MemoryError("refused", `title ${JSON.stringify(title)} yields an empty slug`);
  return s;
}
