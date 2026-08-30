import test from "node:test";
import assert from "node:assert/strict";
import { findSecret } from "../src/secrets.mjs";
const hits = {
  aws: "AKIAIOSFODNN7EXAMPLE",
  github: "ghp_" + "a".repeat(36),
  anthropic: "sk-ant-" + "a".repeat(40),
  openai: "sk-" + "A".repeat(48),
  telegram: "123456789:AAH" + "x".repeat(32),
  pem: "-----BEGIN RSA PRIVATE KEY-----",
  jwt: "eyJhbGciOiJIUzI1NiJ9." + "a".repeat(20) + "." + "b".repeat(20),
  assignment: "password = hunter2secret",
  bearer: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
};
for (const [name, text] of Object.entries(hits)) {
  test(`detects ${name}`, () => assert.equal(findSecret(`before ${text} after`)?.name, name));
}
test("plain prose and short tokens pass", () => {
  assert.equal(findSecret("set TELEGRAM_CHAT_ID to 8769818127 from vars.zsh"), null);
  assert.equal(findSecret("the password field is required"), null);
  assert.equal(findSecret("token=abc"), null);
});
