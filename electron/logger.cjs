const fs = require("fs");
const path = require("path");

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function redactText(input, sensitiveValues = []) {
  let value = String(input ?? "");
  for (const secret of sensitiveValues) {
    const normalized = String(secret ?? "");
    if (normalized.length >= 4) value = value.split(normalized).join("<redacted>");
  }
  return value
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, "$1<redacted>")
    .replace(/((?:https?|socks4|socks5h?):\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/((?:api[_ -]?key|secret(?:[_ -]?key)?|passphrase|authorization|proxy(?:url)?|license[_ -]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1<redacted>");
}

function sanitize(value, sensitiveValues, depth = 0) {
  if (depth > 5) return "<depth-limit>";
  if (value instanceof Error) return { name: value.name, message: redactText(value.message, sensitiveValues), stack: redactText(value.stack, sensitiveValues) };
  if (typeof value === "string") return redactText(value, sensitiveValues);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, sensitiveValues, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => {
      if (/api.?key|secret|passphrase|authorization|proxy.?url|license.?key/i.test(key)) return [key, "<redacted>"];
      return [key, sanitize(item, sensitiveValues, depth + 1)];
    }));
  }
  return redactText(value, sensitiveValues);
}

class RollingLogger {
  constructor(logPath, maxBytes = MAX_LOG_BYTES) {
    this.logPath = logPath;
    this.maxBytes = maxBytes;
    this.sensitiveValues = new Set();
  }

  setSensitiveValues(values = []) {
    this.sensitiveValues = new Set(values.flat(Infinity).filter((value) => typeof value === "string" && value.length >= 4));
  }

  write(level, event, details = {}) {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      const line = `${JSON.stringify({ timestamp: new Date().toISOString(), level, event: redactText(event, this.sensitiveValues), details: sanitize(details, this.sensitiveValues) })}\n`;
      fs.appendFileSync(this.logPath, line, { encoding: "utf8", mode: 0o600 });
      this.rotate();
    } catch { /* Logging must never crash trading. */ }
  }

  rotate() {
    const stat = fs.statSync(this.logPath);
    if (stat.size <= this.maxBytes) return;
    const data = fs.readFileSync(this.logPath);
    let tail = data.subarray(Math.max(0, data.length - this.maxBytes));
    const firstNewline = tail.indexOf(0x0a);
    if (firstNewline >= 0 && firstNewline < tail.length - 1) tail = tail.subarray(firstNewline + 1);
    fs.writeFileSync(this.logPath, tail, { mode: 0o600 });
  }

  snapshot() {
    try {
      const data = fs.readFileSync(this.logPath);
      return data.length <= this.maxBytes ? data : data.subarray(data.length - this.maxBytes);
    } catch (error) {
      if (error?.code === "ENOENT") return Buffer.from("");
      throw error;
    }
  }
}

module.exports = { MAX_LOG_BYTES, RollingLogger, redactText, sanitize };
