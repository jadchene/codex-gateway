const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { dbPath, dataDir } = require("./paths.cjs");

function now() {
  return Math.floor(Date.now() / 1000);
}

function createStore(options = {}) {
  const secretCodec = options.secretCodec;
  if (!secretCodec) throw new Error("createStore requires a secret codec.");
  const targetDataDir = options.dataDir || dataDir();
  const targetDbPath = options.dbPath || dbPath();
  fs.mkdirSync(targetDataDir, { recursive: true });
  const db = new DatabaseSync(targetDbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  migrateSecrets(db, secretCodec);
  return {
    db,
    paths: { dataDir: targetDataDir, dbPath: targetDbPath },
    getSettings: () => getSettings(db),
    saveSettings: (patch) => saveSettings(db, patch),
    listAccounts: () => listAccounts(db, secretCodec),
    saveAccount: (input) => saveAccount(db, input, secretCodec),
    setAccountEnabled: (id, enabled) => setAccountEnabled(db, id, enabled),
    deleteAccount: (id) => db.prepare("DELETE FROM accounts WHERE id = ?").run(id),
    updateUsage: (id, usage) => updateUsage(db, id, usage),
    saveLoginSession: (session) => saveLoginSession(db, session, secretCodec),
    getLoginSession: (id) => getLoginSession(db, id, secretCodec),
    updateLoginSession: (id, status, error) => updateLoginSession(db, id, status, error),
    listCodexSessions: (query) => listCodexSessions(db, query),
    saveCodexSession: (session) => saveCodexSession(db, session),
    deleteCodexSession: (sessionId) => deleteCodexSession(db, sessionId),
    listTokenLogs: (query) => listTokenLogs(db, query),
    addTokenLog: (entry) => addTokenLog(db, entry),
    clearTokenLogs: () => clearTokenLogs(db),
    tokenSummary: (query) => tokenSummary(db, query),
    getLastRefreshAllUsageAt: () => getLastRefreshAllUsageAt(db),
    listAppLogs: (query) => listAppLogs(db, query),
    addAppLog: (entry) => addAppLog(db, entry),
    clearAppLogs: () => clearAppLogs(db),
    runMaintenance: () => runMaintenance(db),
    compactDatabase: () => compactDatabase(db)
  };
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
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
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT,
      method TEXT NOT NULL,
      request_path TEXT,
      upstream_path TEXT,
      session_id TEXT,
      version TEXT,
      status INTEGER,
      duration_ms INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_sessions (
      id TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codex_sessions (
      session_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'info',
      scope TEXT,
      action TEXT,
      status TEXT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_request_logs_account_created ON request_logs(account_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_app_logs_created_at ON app_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_login_sessions_updated_at ON login_sessions(updated_at);
  `);
  addColumnIfMissing(db, "accounts", "id_token", "TEXT");
  addColumnIfMissing(db, "accounts", "last_refresh", "TEXT");
  addColumnIfMissing(db, "request_logs", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "request_logs", "request_path", "TEXT");
  addColumnIfMissing(db, "request_logs", "upstream_path", "TEXT");
  addColumnIfMissing(db, "request_logs", "session_id", "TEXT");
  addColumnIfMissing(db, "request_logs", "version", "TEXT");
  dropColumnIfExists(db, "request_logs", "path");
  addColumnIfMissing(db, "request_logs", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "request_logs", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "request_logs", "reasoning_output_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "request_logs", "total_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "codex_sessions", "note", "TEXT");
  addColumnIfMissing(db, "accounts", "reset_credits_available_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "accounts", "reset_credits_next_expires_at", "INTEGER");
  addColumnIfMissing(db, "accounts", "reset_credits_json", "TEXT");
  const defaults = {
    gateway_host: "localhost",
    gateway_port: "8436",
    gateway_api_key: randomGatewayApiKey(),
    upstream_base_url: "https://chatgpt.com/backend-api/codex",
    request_timeout_ms: "0",
    gateway_connect_timeout_ms: "30000",
    gateway_stream_idle_timeout_ms: "120000",
    gateway_unary_timeout_ms: "300000",
    gateway_shutdown_grace_ms: "2000",
    gateway_request_body_limit_bytes: "67108864",
    gateway_error_body_limit_bytes: "1048576",
    gateway_max_concurrent_requests: "16",
    gateway_websocket_max_connections: "128",
    gateway_websocket_max_payload_bytes: "134217728",
    gateway_websocket_buffer_high_water_bytes: "4194304",
    gateway_websocket_idle_timeout_ms: "120000",
    gateway_quota_cooldown_ms: "60000",
    usage_refresh_interval_secs: "900",
    usage_refresh_timeout_ms: "20000",
    last_usage_refresh_all_at: "0",
    auto_start_gateway: "false",
    auto_start_mcp_gateway: "false",
    mcp_gateway_config_path: "",
    mcp_gateway_host: "127.0.0.1",
    mcp_gateway_port: "3000",
    mcp_gateway_path: "/mcp",
    startup_launch: "disabled",
    close_behavior: "exit",
    codex_quota_headers_mode: "block",
    codex_auth_mode: "gateway",
    codex_selected_account_id: "",
    gateway_current_account_id: "",
    gateway_last_daily_rebalance_date: "",
    gateway_affinity_state_json: "{}",
    ignore_five_hour_limit: "false",
    billing_uncached_input_factor: "125",
    billing_cached_input_factor: "12.5",
    billing_output_factor: "750",
    request_log_retention_days: "30",
    app_log_retention_days: "14"
  };
  const insert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);
  fillBlankSetting(db, "mcp_gateway_host", "127.0.0.1");
  fillBlankSetting(db, "mcp_gateway_port", "3000");
  fillBlankSetting(db, "mcp_gateway_path", "/mcp");
  repairLastRefreshAllUsageAt(db);
}

function randomGatewayApiKey() {
  return `sk-${crypto.randomBytes(24).toString("base64url")}`;
}

function migrateSecrets(db, secretCodec) {
  const accountRows = db.prepare("SELECT id, id_token, access_token, refresh_token FROM accounts").all();
  const loginRows = db.prepare("SELECT id, code_verifier FROM login_sessions").all();
  const accountUpdate = db.prepare(`
    UPDATE accounts SET id_token = ?, access_token = ?, refresh_token = ? WHERE id = ?
  `);
  const loginUpdate = db.prepare("UPDATE login_sessions SET code_verifier = ? WHERE id = ?");
  let changed = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of accountRows) {
      const values = [row.id_token, row.access_token, row.refresh_token];
      if (!values.some((value) => value && !secretCodec.isEncrypted(value))) continue;
      accountUpdate.run(
        secretCodec.encrypt(row.id_token),
        secretCodec.encrypt(row.access_token),
        secretCodec.encrypt(row.refresh_token),
        row.id
      );
      changed = true;
    }
    for (const row of loginRows) {
      if (!row.code_verifier || secretCodec.isEncrypted(row.code_verifier)) continue;
      loginUpdate.run(secretCodec.encrypt(row.code_verifier), row.id);
      changed = true;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (changed) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
  }
}

function getSettings(db) {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function saveSettings(db, patch) {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(patch)) stmt.run(key, String(value ?? ""));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getSettings(db);
}

function listAccounts(db, secretCodec) {
  return db.prepare("SELECT * FROM accounts ORDER BY created_at ASC, id ASC").all()
    .map((row) => decodeAccountSecrets(row, secretCodec));
}

function saveAccount(db, input, secretCodec) {
  const ts = now();
  const id = input.id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO accounts (
      id, name, email, id_token, access_token, refresh_token, last_refresh, account_id, workspace_id, status, enabled, priority,
      subscription_plan, subscription_expires_at, quota_5h_used_percent, quota_5h_reset_at,
      quota_7d_used_percent, quota_7d_reset_at, reset_credits_available_count, reset_credits_next_expires_at,
      reset_credits_json, raw_usage_json, note, created_at, updated_at
    ) VALUES (
      @id, @name, @email, @id_token, @access_token, @refresh_token, @last_refresh, @account_id, @workspace_id, @status, @enabled, @priority,
      @subscription_plan, @subscription_expires_at, @quota_5h_used_percent, @quota_5h_reset_at,
      @quota_7d_used_percent, @quota_7d_reset_at, @reset_credits_available_count, @reset_credits_next_expires_at,
      @reset_credits_json, @raw_usage_json, @note, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      id_token = excluded.id_token,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      last_refresh = excluded.last_refresh,
      account_id = excluded.account_id,
      workspace_id = excluded.workspace_id,
      status = excluded.status,
      enabled = excluded.enabled,
      priority = excluded.priority,
      subscription_plan = excluded.subscription_plan,
      subscription_expires_at = excluded.subscription_expires_at,
      quota_5h_used_percent = excluded.quota_5h_used_percent,
      quota_5h_reset_at = excluded.quota_5h_reset_at,
      quota_7d_used_percent = excluded.quota_7d_used_percent,
      quota_7d_reset_at = excluded.quota_7d_reset_at,
      reset_credits_available_count = excluded.reset_credits_available_count,
      reset_credits_next_expires_at = excluded.reset_credits_next_expires_at,
      reset_credits_json = excluded.reset_credits_json,
      raw_usage_json = excluded.raw_usage_json,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(encodeAccountSecrets(normalizeAccount({ ...input, id, created_at: input.created_at || ts, updated_at: ts }), secretCodec));
  return decodeAccountSecrets(db.prepare("SELECT * FROM accounts WHERE id = ?").get(id), secretCodec);
}

function normalizeAccount(input) {
  return {
    id: input.id,
    name: String(input.name || input.email || "GPT Account").trim(),
    email: input.email || null,
    id_token: input.id_token || null,
    access_token: String(input.access_token || "").trim(),
    refresh_token: input.refresh_token || null,
    last_refresh: input.last_refresh || null,
    account_id: input.account_id || null,
    workspace_id: input.workspace_id || null,
    status: input.status || "active",
    enabled: input.enabled === false || input.enabled === 0 ? 0 : 1,
    priority: Number(input.priority || 100),
    subscription_plan: input.subscription_plan || null,
    subscription_expires_at: input.subscription_expires_at || null,
    quota_5h_used_percent: Number(input.quota_5h_used_percent || 0),
    quota_5h_reset_at: input.quota_5h_reset_at || null,
    quota_7d_used_percent: Number(input.quota_7d_used_percent || 0),
    quota_7d_reset_at: input.quota_7d_reset_at || null,
    reset_credits_available_count: Number(input.reset_credits_available_count || 0),
    reset_credits_next_expires_at: input.reset_credits_next_expires_at || null,
    reset_credits_json: input.reset_credits_json || null,
    raw_usage_json: input.raw_usage_json || null,
    note: input.note || null,
    created_at: input.created_at,
    updated_at: input.updated_at
  };
}

function encodeAccountSecrets(account, secretCodec) {
  return {
    ...account,
    id_token: secretCodec.encrypt(account.id_token),
    access_token: secretCodec.encrypt(account.access_token),
    refresh_token: secretCodec.encrypt(account.refresh_token)
  };
}

function decodeAccountSecrets(account, secretCodec) {
  if (!account) return account;
  return {
    ...account,
    id_token: secretCodec.decrypt(account.id_token),
    access_token: secretCodec.decrypt(account.access_token),
    refresh_token: secretCodec.decrypt(account.refresh_token),
    enabled: Boolean(account.enabled)
  };
}

function updateUsage(db, id, usage) {
  const params = {
    quota_5h_used_percent: null,
    quota_5h_reset_at: null,
    quota_7d_used_percent: null,
    quota_7d_reset_at: null,
    reset_credits_available_count: null,
    reset_credits_next_expires_at: null,
    reset_credits_json: null,
    raw_usage_json: null,
    ...usage,
    id,
    updated_at: now()
  };
  db.prepare(`
    UPDATE accounts SET
      quota_5h_used_percent = COALESCE(@quota_5h_used_percent, quota_5h_used_percent),
      quota_5h_reset_at = COALESCE(@quota_5h_reset_at, quota_5h_reset_at),
      quota_7d_used_percent = COALESCE(@quota_7d_used_percent, quota_7d_used_percent),
      quota_7d_reset_at = COALESCE(@quota_7d_reset_at, quota_7d_reset_at),
      reset_credits_available_count = COALESCE(@reset_credits_available_count, reset_credits_available_count),
      reset_credits_next_expires_at = COALESCE(@reset_credits_next_expires_at, reset_credits_next_expires_at),
      reset_credits_json = COALESCE(@reset_credits_json, reset_credits_json),
      raw_usage_json = COALESCE(@raw_usage_json, raw_usage_json),
      updated_at = @updated_at
    WHERE id = @id
  `).run(params);
}

function setAccountEnabled(db, id, enabled) {
  db.prepare("UPDATE accounts SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, now(), id);
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function dropColumnIfExists(db, table, column) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) return;
  try {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  } catch {
    // Older SQLite builds may not support DROP COLUMN. The application no longer reads or writes this field.
  }
}

function fillBlankSetting(db, key, value) {
  db.prepare("UPDATE settings SET value = ? WHERE key = ? AND TRIM(value) = ''").run(value, key);
}

function saveLoginSession(db, session, secretCodec) {
  const ts = now();
  db.prepare(`
    INSERT INTO login_sessions (id, code_verifier, redirect_uri, status, error, created_at, updated_at)
    VALUES (@id, @code_verifier, @redirect_uri, @status, NULL, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      code_verifier = excluded.code_verifier,
      redirect_uri = excluded.redirect_uri,
      status = excluded.status,
      error = NULL,
      updated_at = excluded.updated_at
  `).run({ ...session, code_verifier: secretCodec.encrypt(session.code_verifier), created_at: ts, updated_at: ts });
}

function getLoginSession(db, id, secretCodec) {
  const session = db.prepare("SELECT * FROM login_sessions WHERE id = ?").get(id);
  return session ? { ...session, code_verifier: secretCodec.decrypt(session.code_verifier) } : undefined;
}

function updateLoginSession(db, id, status, error) {
  db.prepare(`
    UPDATE login_sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?
  `).run(status, error || null, now(), id);
}

function listCodexSessions(db, query = {}) {
  const name = cleanSessionName(query.name);
  const page = clampInt(query.page, 1, 1, 100000);
  const pageSize = clampInt(query.pageSize, 10, 5, 200);
  const offset = (page - 1) * pageSize;
  const clauses = [];
  const params = [];
  if (name) {
    clauses.push("name LIKE ?");
    params.push(`%${name}%`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const items = db.prepare(`
    SELECT * FROM codex_sessions
    ${where}
    ORDER BY updated_at DESC, created_at DESC, session_id ASC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM codex_sessions
    ${where}
  `).get(...params).total;
  return { items, total, page, pageSize, name };
}

function saveCodexSession(db, input) {
  const sessionId = cleanFilterValue(input?.session_id);
  const name = cleanSessionName(input?.name);
  const note = cleanSessionNote(input?.note);
  if (!sessionId) throw new Error("会话 ID 不能为空。");
  if (!name) throw new Error("会话名称不能为空。");
  const existing = db.prepare("SELECT created_at FROM codex_sessions WHERE session_id = ?").get(sessionId);
  const ts = now();
  db.prepare(`
    INSERT INTO codex_sessions (session_id, name, note, created_at, updated_at)
    VALUES (@session_id, @name, @note, @created_at, @updated_at)
    ON CONFLICT(session_id) DO UPDATE SET
      name = excluded.name,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run({
    session_id: sessionId,
    name,
    note,
    created_at: existing?.created_at || ts,
    updated_at: ts
  });
  return db.prepare("SELECT * FROM codex_sessions WHERE session_id = ?").get(sessionId);
}

function deleteCodexSession(db, sessionId) {
  const id = cleanFilterValue(sessionId);
  if (!id) throw new Error("会话 ID 不能为空。");
  const result = db.prepare("DELETE FROM codex_sessions WHERE session_id = ?").run(id);
  return { deleted: Number(result.changes || 0) };
}

function addTokenLog(db, entry) {
  db.prepare(`
    INSERT INTO request_logs (
      account_id, method, request_path, upstream_path, session_id, version, status, duration_ms,
      input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
      message, created_at
    )
    VALUES (
      @account_id, @method, @request_path, @upstream_path, @session_id, @version, @status, @duration_ms,
      @input_tokens, @cached_input_tokens, @output_tokens, @reasoning_output_tokens, @total_tokens,
      @message, @created_at
    )
  `).run({
    account_id: entry.account_id || null,
    method: entry.method || "GET",
    request_path: entry.request_path || null,
    upstream_path: entry.upstream_path || null,
    session_id: entry.session_id || null,
    version: entry.version || null,
    status: entry.status || null,
    duration_ms: entry.duration_ms || null,
    input_tokens: toInt(entry.input_tokens),
    cached_input_tokens: toInt(entry.cached_input_tokens),
    output_tokens: toInt(entry.output_tokens),
    reasoning_output_tokens: toInt(entry.reasoning_output_tokens),
    total_tokens: toInt(entry.total_tokens),
    message: entry.message || null,
    created_at: now()
  });
}

function clearTokenLogs(db) {
  const result = db.prepare("DELETE FROM request_logs").run();
  compactDatabase(db);
  return { deleted: Number(result.changes || 0) };
}

function listTokenLogs(db, query) {
  const range = normalizeLogQuery(query);
  const filter = tokenLogFilter(range);
  const items = db.prepare(`
    SELECT request_logs.*, accounts.name AS account_name, accounts.email AS account_email
    FROM request_logs
    LEFT JOIN accounts ON accounts.id = request_logs.account_id
    WHERE ${filter.where}
    ORDER BY request_logs.id DESC
    LIMIT ? OFFSET ?
  `).all(...filter.params, range.pageSize, range.offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM request_logs
    LEFT JOIN accounts ON accounts.id = request_logs.account_id
    WHERE ${filter.where}
  `).get(...filter.params).total;
  return { items, total, page: range.page, pageSize: range.pageSize, startAt: range.startAt, endAt: range.endAt };
}

function tokenSummary(db, query) {
  const range = normalizeLogQuery(query);
  const filter = tokenLogFilter(range);
  const total = db.prepare(`
    SELECT
      COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM request_logs
    LEFT JOIN accounts ON accounts.id = request_logs.account_id
    WHERE ${filter.where}
  `).get(...filter.params);
  const byAccount = db.prepare(`
    SELECT
      request_logs.account_id,
      COALESCE(accounts.name, request_logs.account_id, '未关联账号') AS account_name,
      COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM request_logs
    LEFT JOIN accounts ON accounts.id = request_logs.account_id
    WHERE ${filter.where}
    GROUP BY request_logs.account_id
    ORDER BY total_tokens DESC
  `).all(...filter.params);
  return { total, byAccount };
}

function tokenLogFilter(range) {
  const clauses = [
    "request_logs.created_at >= ?",
    "request_logs.created_at < ?"
  ];
  const params = [range.startAt, range.endAt];
  if (range.accountId) {
    clauses.push("request_logs.account_id = ?");
    params.push(range.accountId);
  }
  if (range.sessionId) {
    clauses.push("request_logs.session_id LIKE ?");
    params.push(`%${range.sessionId}%`);
  }
  return { where: clauses.join(" AND "), params };
}

function addAppLog(db, entry) {
  db.prepare(`
    INSERT INTO app_logs (level, scope, action, status, message, created_at)
    VALUES (@level, @scope, @action, @status, @message, @created_at)
  `).run({
    level: entry.level || "info",
    scope: entry.scope || null,
    action: entry.action || null,
    status: entry.status || null,
    message: String(entry.message || ""),
    created_at: now()
  });
}

function getLastRefreshAllUsageAt(db) {
  const setting = db.prepare("SELECT value FROM settings WHERE key = ?").get("last_usage_refresh_all_at");
  const settingTime = Number(setting?.value || 0);
  if (Number.isFinite(settingTime) && settingTime > 0) return Math.trunc(settingTime);
  const row = db.prepare(`
    SELECT MAX(created_at) AS created_at
    FROM app_logs
    WHERE scope = 'usage' AND action = 'refresh-all' AND status = 'success'
  `).get();
  const logTime = Number(row?.created_at || 0);
  return Number.isFinite(logTime) ? Math.trunc(logTime) : 0;
}

function repairLastRefreshAllUsageAt(db) {
  const setting = db.prepare("SELECT value FROM settings WHERE key = ?").get("last_usage_refresh_all_at");
  const settingTime = Number(setting?.value || 0);
  if (!Number.isFinite(settingTime) || settingTime <= 0) return;
  const matchingLogs = db.prepare(`
    SELECT status FROM app_logs
    WHERE scope = 'usage' AND action = 'refresh-all' AND created_at = ?
  `).all(Math.trunc(settingTime));
  if (matchingLogs.length === 0 || matchingLogs.some((row) => row.status === "success")) return;
  const successful = db.prepare(`
    SELECT MAX(created_at) AS created_at FROM app_logs
    WHERE scope = 'usage' AND action = 'refresh-all' AND status = 'success'
  `).get();
  const repaired = Number(successful?.created_at || 0);
  db.prepare("UPDATE settings SET value = ? WHERE key = ?")
    .run(String(Number.isFinite(repaired) ? Math.trunc(repaired) : 0), "last_usage_refresh_all_at");
}

function clearAppLogs(db) {
  const result = db.prepare("DELETE FROM app_logs").run();
  compactDatabase(db);
  return { deleted: Number(result.changes || 0) };
}

function runMaintenance(db) {
  const settings = getSettings(db);
  const requestDays = clampInt(settings.request_log_retention_days, 30, 1, 3650);
  const appDays = clampInt(settings.app_log_retention_days, 14, 1, 3650);
  const current = now();
  const requestResult = db.prepare("DELETE FROM request_logs WHERE created_at < ?")
    .run(current - requestDays * 86400);
  const appResult = db.prepare("DELETE FROM app_logs WHERE created_at < ?")
    .run(current - appDays * 86400);
  const loginResult = db.prepare("DELETE FROM login_sessions WHERE updated_at < ?")
    .run(current - 7 * 86400);
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  return {
    requestLogsDeleted: Number(requestResult.changes || 0),
    appLogsDeleted: Number(appResult.changes || 0),
    loginSessionsDeleted: Number(loginResult.changes || 0)
  };
}

function compactDatabase(db) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  return { compacted: true };
}

function listAppLogs(db, query) {
  const range = normalizeLogQuery(query);
  const items = db.prepare(`
    SELECT * FROM app_logs
    WHERE created_at >= ? AND created_at < ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(range.startAt, range.endAt, range.pageSize, range.offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS total FROM app_logs WHERE created_at >= ? AND created_at < ?
  `).get(range.startAt, range.endAt).total;
  return { items, total, page: range.page, pageSize: range.pageSize, startAt: range.startAt, endAt: range.endAt };
}

function normalizeLogQuery(query = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const page = clampInt(query.page, 1, 1, 100000);
  const pageSize = clampInt(query.pageSize, 10, 5, 200);
  const startAt = clampInt(query.startAt, Math.floor(today.getTime() / 1000), 0, 4102444800);
  const endAt = clampInt(query.endAt, Math.floor(tomorrow.getTime() / 1000), startAt + 1, 4102444800);
  return {
    page,
    pageSize,
    startAt,
    endAt,
    accountId: cleanFilterValue(query.accountId),
    sessionId: cleanFilterValue(query.sessionId),
    offset: (page - 1) * pageSize
  };
}

function cleanFilterValue(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 240) : "";
}

function cleanSessionName(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 120) : "";
}

function cleanSessionNote(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 1000) : null;
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function toInt(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

module.exports = {
  createStore
};
