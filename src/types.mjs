export const TYPES = ["User", "Feedback", "Project", "Reference", "Session Summary"];
export const TYPE_DIRS = {
  User: "user", Feedback: "feedback", Project: "project", Reference: "reference", "Session Summary": "session-summaries",
};
export function dirForType(type) { return TYPE_DIRS[type]; }
export function typeForDir(dir) { return Object.keys(TYPE_DIRS).find((t) => TYPE_DIRS[t] === dir); }
export function legalTypes(isRoot) { return TYPES.filter((t) => (isRoot ? t !== "Project" : t !== "User")); }
