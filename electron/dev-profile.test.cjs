const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { importProfile } = require("../scripts/import-desktop-profile.cjs");

test("development import preserves encrypted bytes and device identity without altering installed settings", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hedge-profile-test-"));
  try {
    const source = path.join(directory, "hedge-lbank"); fs.mkdirSync(source);
    const bytes = Buffer.from([0, 123, 9, 255]);
    fs.writeFileSync(path.join(source, "credentials.bin"), bytes);
    fs.writeFileSync(path.join(source, "device.id"), "test-device");
    fs.writeFileSync(path.join(source, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: "test-ciphertext" } }));
    const settings = { source: "okx", target: "gateio", liveTradingEnabled: false, autoUpdate: true, margin: 10, selected: ["XRP"] };
    fs.writeFileSync(path.join(source, "settings.ini"), JSON.stringify(settings));
    const { destination } = importProfile(directory);
    assert.deepEqual(fs.readFileSync(path.join(destination, "credentials.bin")), bytes);
    assert.equal(fs.readFileSync(path.join(destination, "device.id"), "utf8"), "test-device");
    assert.deepEqual(fs.readFileSync(path.join(destination, "Local State")), fs.readFileSync(path.join(source, "Local State")));
    const local = JSON.parse(fs.readFileSync(path.join(destination, "settings.ini"), "utf8"));
    assert.equal(local.margin, 10); assert.equal(local.liveTradingEnabled, true); assert.equal(local.autoUpdate, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source, "settings.ini"), "utf8")), settings);
    assert.throws(() => importProfile(directory), /перезапись запрещена/);
    assert.equal(fs.existsSync(path.join(destination, "hedge-session.json")), false);
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("hedge-profile-test-")) throw new Error("Unexpected cleanup target");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
