const PATTERNS = [
  ["aws", /\bAKIA[0-9A-Z]{16}\b/],
  ["github", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["anthropic", /\bsk-ant-[A-Za-z0-9_-]{32,}\b/],
  ["openai", /\bsk-[A-Za-z0-9]{40,}\b/],
  ["telegram", /\b\d{8,10}:AA[A-Za-z0-9_-]{32,}\b/],
  ["pem", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["bearer", /\bBearer\s+[A-Za-z0-9._-]{20,}/],
  ["assignment", /\b(password|passwd|secret|api[_-]?key|token)\s*[=:]\s*["']?(?=[A-Za-z0-9_\-./+=]*\d)[A-Za-z0-9_\-./+=]{12,}/i],
];
export function findSecret(text) {
  for (const [name, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) return { name, index: m.index };
  }
  return null;
}
