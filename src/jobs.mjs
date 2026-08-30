import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnDetached } from "./git.mjs";
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "memory.mjs");
export function afterWrite(bundle, { dirRel, message }) {
  if (process.env.MEMORY_SYNC_INLINE === "1") return; // tests run the job inline instead
  spawnDetached([BIN, "_job", "--dir", bundle.root, "--index", dirRel, "--commit", message]);
}
