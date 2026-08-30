import { MemoryError } from "./errors.mjs";
const AGENT = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;
const HUMAN = /^human:[A-Za-z0-9._-]+$/;
const PROCESS = /^process:[A-Za-z0-9._-]+$/;
export function parseActor(s) {
  if (typeof s !== "string") throw new MemoryError("refused", "actor must be a string");
  if (HUMAN.test(s)) return { value: s, class: "human" };
  if (PROCESS.test(s)) return { value: s, class: "process" };
  if (AGENT.test(s)) return { value: s, class: "agent" };
  throw new MemoryError("refused", `malformed actor ${JSON.stringify(s)}: use <producer>/<version>, human:<id> or process:<id>`);
}
