const http = require("http");
const https = require("https");
const dns = require("dns");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);

function resolveProxy(credentials = {}) {
  if (credentials.proxyEnabled !== true && credentials.proxyEnabled !== "true") return null;
  const raw = String(credentials.proxyUrl || "").trim();
  if (!raw) throw new Error("Proxy включён, но адрес не указан");
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("Некорректный адрес proxy"); }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Proxy должен использовать HTTP, HTTPS, SOCKS4 или SOCKS5");
  }
  return parsed;
}

function createProxyAgent(proxy) {
  if (!proxy) return undefined;
  if (proxy.protocol.startsWith("socks")) return new SocksProxyAgent(proxy);
  return new HttpsProxyAgent(proxy);
}

function sanitizeNetworkError(error, exchangeName = "Биржа", proxyEnabled = false) {
  const code = error?.code || error?.cause?.code;
  if (error?.name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return `${exchangeName}: превышено время ожидания API`;
  if (code === "ENOTFOUND") return proxyEnabled ? `${exchangeName}: proxy не смог разрешить адрес API (ENOTFOUND)` : `${exchangeName}: текущая сеть не разрешает адрес API — включите proxy для этой биржи`;
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    return `${exchangeName}: сеть или proxy недоступны (${code})`;
  }
  if (/fetch failed/i.test(String(error?.message || error))) return proxyEnabled ? `${exchangeName}: API недоступен через указанный proxy` : `${exchangeName}: API недоступен по текущей сети — включите proxy для этой биржи`;
  return `${exchangeName}: ${error instanceof Error ? error.message : String(error)}`;
}

function resilientLookup(hostname, options, callback) {
  const done = (error, address, family) => {
    if (error) callback(error);
    else if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  dns.lookup(hostname, { family: 4 }, (error, address, family) => {
    if (!error) { done(null, address, family); return; }
    if (error.code !== "ENOTFOUND" && error.code !== "EAI_AGAIN") { done(error); return; }
    const resolver = new dns.Resolver();
    resolver.setServers(["1.1.1.1", "8.8.8.8"]);
    resolver.resolve4(hostname, (fallbackError, addresses) => {
      if (fallbackError || !addresses?.length) done(fallbackError || error);
      else done(null, addresses[0], 4);
    });
  });
}

function directRequest(url, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const request = client.request(target, { method: options.method, headers: options.headers, lookup: resilientLookup }, (response) => {
      response.on("error", reject);
      response.on("aborted", () => reject(Object.assign(new Error("Ответ API прерван"), { code: "ECONNRESET" })));
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { request.destroy(new Error("Ответ API превышает допустимый размер")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
        status: response.statusCode || 0,
        headers: response.headers,
        text: async () => Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.setTimeout(options.timeoutMs, () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function proxiedRequest(url, options, proxy) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const request = client.request(target, {
      method: options.method,
      headers: options.headers,
      agent: createProxyAgent(proxy),
    }, (response) => {
      response.on("error", reject);
      response.on("aborted", () => reject(Object.assign(new Error("Ответ API прерван"), { code: "ECONNRESET" })));
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Ответ API превышает допустимый размер"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
        status: response.statusCode || 0,
        headers: response.headers,
        text: async () => Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.setTimeout(options.timeoutMs, () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function requestJson(url, {
  method = "GET",
  headers = {},
  body,
  credentials = {},
  timeoutMs = 15_000,
  exchangeName = "Биржа",
  validate,
} = {}) {
  const proxy = resolveProxy(credentials);
  // The query can contain a signature/API key. Diagnostics retain only the route.
  const target = new URL(url), endpoint = `${target.origin}${target.pathname}`;
  let response;
  try {
    const options = { method: String(method).toUpperCase(), headers, body, timeoutMs };
    response = proxy ? await proxiedRequest(url, options, proxy) : await directRequest(url, options);
  } catch (error) {
    throw Object.assign(new Error(sanitizeNetworkError(error, exchangeName, Boolean(proxy))), {
      code: error?.code || error?.cause?.code, endpoint,
    });
  }

  const text = await response.text();
  let payload, parsed = false;
  try { payload = text ? JSON.parse(text) : {}; parsed = true; } catch {}
  if (!response.ok) {
    const detail = payload?.msg || payload?.message || payload?.retMsg || payload?.error?.message;
    const message = typeof detail === "string" && detail.trim() ? detail.slice(0, 300) : ({
      401: "API отклонил авторизацию; проверьте API-ключ и его разрешения",
      403: "сервер отказал в доступе к API; проверьте разрешения API, список разрешённых IP и сеть/proxy",
      407: "proxy требует авторизацию; проверьте логин и пароль proxy",
      429: "превышен лимит запросов API; дождитесь окончания паузы",
    }[response.status] || "сервер API вернул ошибку");
    const retryAfter = response.headers?.["retry-after"];
    const retryAfterMs = retryAfter == null ? undefined : /^\d+(?:\.\d+)?$/.test(String(retryAfter))
      ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    // HTTP failures, including HTML from an upstream gateway, say nothing about
    // whether an earlier order was accepted. Never turn them into empty data or
    // a definitive order rejection that could trigger another submission.
    const exchangeCode = parsed ? payload?.code ?? payload?.retCode ?? payload?.label ?? payload?.error?.label ?? payload?.error?.code : undefined;
    throw Object.assign(new Error(`${exchangeName}: ${message} (HTTP ${response.status})`), {
      code: response.status === 403 ? "API_ACCESS_DENIED" : response.status === 429 ? "API_RATE_LIMIT" : "API_HTTP_ERROR",
      httpStatus: response.status, endpoint, ...(exchangeCode != null ? { exchangeCode: String(exchangeCode) } : {}),
      ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
    });
  }
  if (!parsed) {
    throw Object.assign(new Error(`${exchangeName}: API вернул некорректный JSON (HTTP ${response.status})`), {
      code: "API_INVALID_RESPONSE", httpStatus: response.status, endpoint,
    });
  }
  if (validate) {
    try { validate(payload); }
    catch (error) { if (error.definitive == null) error.definitive = true; throw error; }
  }
  return payload;
}

module.exports = { requestJson, resolveProxy, sanitizeNetworkError, resilientLookup };
