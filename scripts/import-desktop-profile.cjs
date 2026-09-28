const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function importProfile(appData) {
  const source = path.resolve(appData, "hedge-lbank");
  const destination = path.resolve(appData, "hedge-lbank-dev");
  const files = ["credentials.bin", "device.id", "settings.ini"];
  // Windows v10 ciphertext also needs Chromium's DPAPI-protected master key.
  if (fs.existsSync(path.join(source, "Local State"))) files.push("Local State");
  for (const name of files) {
    if (!fs.statSync(path.join(source, name)).isFile()) throw new Error(`Нет исходного файла: ${name}`);
    if (fs.existsSync(path.join(destination, name))) throw new Error(`Локальный ${name} уже существует. Автоматическая перезапись запрещена.`);
  }
  const settings = JSON.parse(fs.readFileSync(path.join(source, "settings.ini"), "utf8"));
  // Live mode still requires a user-started hedge; development must not inherit system integration.
  const localSettings = { ...settings, liveTradingEnabled: true, launchOnStartup: false, autoUpdate: false };
  fs.mkdirSync(destination, { recursive: true });
  // Credentials remain an opaque OS-encrypted blob. Never decrypt them in Node or copy browser storage.
  for (const name of files.filter((name) => name !== "settings.ini")) fs.copyFileSync(path.join(source, name), path.join(destination, name), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(destination, "settings.ini"), JSON.stringify(localSettings, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { destination, files, sourceExchange: settings.source, targetExchange: settings.target, liveTradingEnabled: true };
}

if (require.main === module) {
  try {
    const appData = process.platform === "win32" ? process.env.APPDATA : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    if (!appData) throw new Error("Не удалось определить каталог профилей приложения");
    console.log(JSON.stringify(importProfile(appData)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { importProfile };
