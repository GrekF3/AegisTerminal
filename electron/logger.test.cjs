const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RollingLogger, redactText } = require("./logger.cjs");

test("logger redacts trading secrets and proxy credentials", () => {
  const text = redactText("apiKey=abc123 secret: qwerty proxy=socks5://user:pass@127.0.0.1:9000 Bearer token.value");
  assert.doesNotMatch(text, /abc123|qwerty|user:pass|token\.value/);
});

test("logger keeps only the newest complete lines inside one bounded file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hedge-log-"));
  const target = path.join(directory, "hedge.log");
  const logger = new RollingLogger(target, 1024);
  logger.setSensitiveValues(["private-value"]);
  for (let index = 0; index < 100; index += 1) logger.write("info", "event", { index, payload: `private-value-${"x".repeat(40)}` });
  const files = fs.readdirSync(directory);
  const content = fs.readFileSync(target, "utf8");
  assert.deepEqual(files, ["hedge.log"]);
  assert.ok(fs.statSync(target).size <= 1024);
  assert.doesNotMatch(content, /private-value/);
  assert.match(content, /"index":99/);
  fs.rmSync(directory, { recursive: true, force: true });
});
