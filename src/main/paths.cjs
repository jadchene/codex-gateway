const path = require("node:path");

let app = null;
try {
  app = require("electron").app || null;
} catch {
  app = null;
}

function projectRoot() {
  if (!app || !app.isPackaged) {
    return path.resolve(__dirname, "..", "..");
  }
  return path.dirname(process.execPath);
}

function dataDir() {
  return path.join(projectRoot(), "data");
}

function electronUserDataDir(appInstance = app) {
  if (!appInstance) return path.join(dataDir(), "browser");
  return path.join(appInstance.getPath("appData"), "Codex Gateway");
}

function dbPath() {
  return path.join(dataDir(), "codex-gateway.sqlite");
}

module.exports = {
  projectRoot,
  dataDir,
  electronUserDataDir,
  dbPath
};
