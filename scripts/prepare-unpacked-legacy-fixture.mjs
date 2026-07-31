import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpackedRoot = path.join(projectRoot, "release", "win-unpacked");
const dataDirectory = path.join(unpackedRoot, "data");
const databasePath = path.join(dataDirectory, "codex-gateway.sqlite");
const relativeDataPath = path.relative(unpackedRoot, dataDirectory);

if (relativeDataPath !== "data") throw new Error(`Refusing to replace unexpected fixture path: ${dataDirectory}`);
if (!fs.existsSync(path.join(unpackedRoot, "Codex Gateway.exe"))) {
  throw new Error("Build the unpacked application before preparing its legacy fixture.");
}

fs.rmSync(dataDirectory, { recursive: true, force: true });
fs.mkdirSync(path.join(dataDirectory, "browser"), { recursive: true });
fs.writeFileSync(path.join(dataDirectory, "browser", "v0-browser-marker.txt"), "preserve-me\n", "utf8");

const database = new DatabaseSync(databasePath);
try {
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      id_token TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      last_refresh TEXT,
      account_id TEXT,
      workspace_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      subscription_plan TEXT,
      subscription_expires_at INTEGER,
      quota_5h_used_percent REAL NOT NULL DEFAULT 0,
      quota_5h_reset_at INTEGER,
      quota_7d_used_percent REAL NOT NULL DEFAULT 0,
      quota_7d_reset_at INTEGER,
      reset_credits_available_count INTEGER NOT NULL DEFAULT 0,
      reset_credits_next_expires_at INTEGER,
      reset_credits_json TEXT,
      raw_usage_json TEXT,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO settings (key, value) VALUES
      ('upstream_base_url', 'https://legacy.example.test/backend-api/codex'),
      ('legacy_packaged_fixture', 'preserved'),
      ('auto_start_gateway', 'false'),
      ('auto_start_mcp_gateway', 'false');
  `);
} finally {
  database.close();
}

console.log(`Prepared packaged v0 fixture: ${databasePath}`);
