const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeExchangeIds, testExchangeAccounts } = require("./connection-pool.cjs");

test("connection pool normalizes unique exchange ids", () => {
  assert.deepEqual(normalizeExchangeIds([" OKX ", "okx", "gateio", "../bad", null]), ["okx", "gateio"]);
});

test("connection pool uses isolated credentials and proxy for every exchange", async () => {
  const seen = {};
  const credentials = {
    okx: { apiKey: "okx-key", proxyEnabled: "true", proxyUrl: "socks5://one:1080" },
    gateio: { apiKey: "gate-key", proxyEnabled: "true", proxyUrl: "http://two:8080" },
  };
  const result = await testExchangeAccounts(["okx", "gateio"], credentials, (id) => ({
    getAccount: async (value) => { seen[id] = value; return { total: id === "okx" ? 10 : 20, available: 5 }; },
  }));
  assert.equal(result.okx.ok, true);
  assert.equal(result.gateio.ok, true);
  assert.equal(seen.okx, credentials.okx);
  assert.equal(seen.gateio, credentials.gateio);
  assert.notEqual(seen.okx.proxyUrl, seen.gateio.proxyUrl);
});

test("one failed exchange does not block other automatic connections", async () => {
  const result = await testExchangeAccounts(["okx", "gateio", "missing"], {}, (id) => {
    if (id === "missing") return null;
    return { getAccount: async () => {
      if (id === "okx") throw new Error("temporary outage");
      return { total: 42, available: 40 };
    } };
  });
  assert.match(result.okx.error, /temporary outage/);
  assert.equal(result.gateio.account.total, 42);
  assert.match(result.missing.error, /Адаптер/);
});
