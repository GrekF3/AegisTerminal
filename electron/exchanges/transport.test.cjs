const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { requestJson, resolveProxy, sanitizeNetworkError } = require("./transport.cjs");

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("proxy is configured independently per exchange credentials", () => {
  assert.equal(resolveProxy({ proxyEnabled: false, proxyUrl: "socks5://127.0.0.1:9050" }), null);
  assert.equal(resolveProxy({ proxyEnabled: true, proxyUrl: "socks5://user:pass@127.0.0.1:9050" }).protocol, "socks5:");
  assert.equal(resolveProxy({ proxyEnabled: "true", proxyUrl: "http://127.0.0.1:8080" }).port, "8080");
});

test("proxy rejects unsupported and missing addresses", () => {
  assert.throws(() => resolveProxy({ proxyEnabled: true }), /адрес не указан/);
  assert.throws(() => resolveProxy({ proxyEnabled: true, proxyUrl: "ftp://127.0.0.1" }), /HTTP, HTTPS, SOCKS4 или SOCKS5/);
});

test("network errors do not expose proxy credentials", () => {
  const message = sanitizeNetworkError(Object.assign(new Error("connect user:pass@proxy"), { code: "ECONNREFUSED" }), "Bybit");
  assert.equal(message, "Bybit: сеть или proxy недоступны (ECONNREFUSED)");
});

test("generic fetch failure explains per-exchange proxy requirement", () => {
  assert.match(sanitizeNetworkError(new TypeError("fetch failed"), "OKX", false), /включите proxy для этой биржи/);
  assert.match(sanitizeNetworkError(new TypeError("fetch failed"), "OKX", true), /через указанный proxy/);
});

test("DNS failure is explained without exposing transport internals", () => {
  const error = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  assert.match(sanitizeNetworkError(error, "OKX", false), /текущая сеть не разрешает адрес API/);
});

test("HTML 403 is an access denial with the route, never a JSON error or leaked response", async t => {
  const url = await serve(t, (_req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html><h1>Forbidden</h1>PRIVATE_GATEWAY_DATA</html>');
  });
  await assert.rejects(requestJson(`${url}/account?api_key=PRIVATE_KEY&sign=PRIVATE_SIGN`, { exchangeName: 'LBank' }), error => {
    assert.equal(error.code, 'API_ACCESS_DENIED');
    assert.equal(error.httpStatus, 403);
    assert.equal(error.endpoint, `${url}/account`);
    assert.match(error.message, /отказал в доступе.*HTTP 403/);
    assert.doesNotMatch(error.message, /JSON|PRIVATE/);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
    assert.notEqual(error.definitive, true);
    return true;
  });
});

test("HTML 429 retains the retry delay and does not retry a submitted order", async t => {
  let calls = 0;
  const url = await serve(t, (_req, res) => {
    calls++;
    res.writeHead(429, { 'retry-after': '12' });
    res.end('Too many requests');
  });
  await assert.rejects(requestJson(`${url}/place`, { method: 'POST', body: '{}' }), error => {
    assert.equal(error.httpStatus, 429);
    assert.equal(error.retryAfterMs, 12000);
    assert.notEqual(error.definitive, true);
    return true;
  });
  assert.equal(calls, 1);
});

test("JSON rejection retains exchange detail and HTTP status", async t => {
  const url = await serve(t, (_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ msg: 'Invalid API permissions' }));
  });
  await assert.rejects(requestJson(url), error => error.httpStatus === 401 && /Invalid API permissions.*HTTP 401/.test(error.message));
});

test("JSON rejection preserves a safe scalar exchange code for adapter classification", async t => {
  const url = await serve(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: -2024, msg: 'Position is not sufficient' }));
  });
  await assert.rejects(requestJson(url, { exchangeName: 'Binance' }), error => {
    assert.equal(error.exchangeCode, '-2024');
    assert.equal(error.httpStatus, 400);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
    return true;
  });
});

test("invalid successful JSON is distinguished from an HTTP denial", async t => {
  const url = await serve(t, (_req, res) => res.end('<html>PRIVATE_DATA</html>'));
  await assert.rejects(requestJson(url), error => error.code === 'API_INVALID_RESPONSE' && error.httpStatus === 200 && !error.message.includes('PRIVATE_DATA'));
});

test("a truncated response rejects promptly instead of leaving reconciliation pending", async t => {
  const url = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
    res.write('{');
    setTimeout(() => res.destroy(), 5);
  });
  await assert.rejects(requestJson(url, { timeoutMs: 100 }), error => {
    assert.equal(error.code, 'ECONNRESET');
    assert.notEqual(error.definitive, true);
    return true;
  });
});
