import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnDetached, withLock, commitAll, sync } from "./git.mjs";
import { writeIndex } from "./index-file.mjs";
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "memory.mjs");
// The write-completion job (index regeneration, commit, push), run either in
// this process (tests, and the detached child's own entry point) or spawned
// as a separate detached process. The one place both paths funnel through,
// so a caller of afterWrite never needs its own MEMORY_SYNC_INLINE branch.
export function runJobInline(bundle, dirRel, message) {
  withLock(bundle.root, () => {
    const dir = dirRel ? bundle.dir(dirRel.replace(/^projects\//, "")) : bundle.dir(null);
    writeIndex(bundle, dir);
    commitAll(bundle.root, message);
    sync(bundle.root, { pull: false, push: true });
  });
}
export function afterWrite(bundle, { dirRel, message }) {
  if (process.env.MEMORY_SYNC_INLINE === "1") { runJobInline(bundle, dirRel, message); return; } // tests run the job inline instead
  spawnDetached([BIN, "_job", "--dir", bundle.root, "--index", dirRel, "--commit", message]);
}
