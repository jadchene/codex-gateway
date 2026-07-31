import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ElectronAppLike { isPackaged: boolean }

let app: ElectronAppLike | null = null;
try {
  app = require("electron").app || null;
} catch {
  app = null;
}
export function projectRoot(): string {
  if (!app || !app.isPackaged) {
    return path.resolve(__dirname, "..", "..");
  }
  return path.dirname(process.execPath);
}
export function dataDir(): string {
  return path.join(projectRoot(), "data");
}

export function browserDataDir(): string {
  return path.join(dataDir(), "browser");
}

export function dbPath(): string {
  return path.join(dataDir(), "codex-gateway.sqlite");
}
