const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function codexDir() {
  return path.join(os.homedir(), ".codex");
}

function authPath() {
  return path.join(codexDir(), "auth.json");
}

function configPath() {
  return path.join(codexDir(), "config.toml");
}

function applyGatewayMode(settings) {
  ensureCodexDir();
  const apiKey = String(settings.gateway_api_key || "").trim();
  if (!apiKey) throw new Error("本地 API Key 为空，无法写入 Codex 认证。");
  const currentConfig = readText(configPath());
  const nextConfig = nextGatewayConfig(currentConfig, settings);
  const nextAuth = jsonText({ OPENAI_API_KEY: apiKey });
  writeFilesTransaction([
    { file: authPath(), content: nextAuth },
    { file: configPath(), content: nextConfig }
  ], () => {
    if (readJsonSafe(authPath())?.OPENAI_API_KEY !== apiKey || !hasGatewayProvider(readText(configPath()))) {
      throw new Error("写入后的 Codex 网关认证校验失败。");
    }
  });
  return {
    mode: "gateway",
    authPath: authPath(),
    configPath: configPath(),
    providerChanged: nextConfig !== currentConfig
  };
}

function applyAccountMode(account) {
  ensureCodexDir();
  if (!account) throw new Error("请选择一个账号。");
  if (!account.access_token || !account.refresh_token) {
    throw new Error("账号 token 不完整，无法写入 Codex 认证。");
  }
  const nextAuth = jsonText({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: account.id_token || "",
      access_token: account.access_token || "",
      refresh_token: account.refresh_token || "",
      account_id: account.account_id || account.workspace_id || ""
    },
    last_refresh: account.last_refresh || toIso(account.updated_at) || new Date().toISOString()
  });
  const currentConfig = readText(configPath());
  const nextConfig = withoutGatewayProvider(currentConfig);
  writeFilesTransaction([
    { file: authPath(), content: nextAuth },
    { file: configPath(), content: nextConfig }
  ], () => {
    const auth = readJsonSafe(authPath());
    if (auth?.auth_mode !== "chatgpt" || auth?.tokens?.access_token !== account.access_token || hasGatewayProvider(readText(configPath()))) {
      throw new Error("写入后的 Codex 账号认证校验失败。");
    }
  });
  return {
    mode: "account",
    accountId: account.id,
    authPath: authPath(),
    configPath: configPath(),
    providerRemoved: nextConfig !== currentConfig
  };
}

function ensureProviderConfig(settings) {
  ensureCodexDir();
  const file = configPath();
  const current = readText(file);
  const next = nextGatewayConfig(current, settings);
  if (next === current) return false;
  writeFilesTransaction([{ file, content: next }], () => {
    if (!hasGatewayProvider(readText(file))) throw new Error("Codex Provider 配置校验失败。");
  });
  return true;
}

function nextGatewayConfig(current, settings) {
  const withoutActiveProvider = String(current || "").replace(/^\s*model_provider\s*=.*\r?\n?/m, "");
  return replaceGatewayProviderBlock(withoutActiveProvider, gatewayProviderBlock(settings));
}

function gatewayProviderBlock(settings) {
  const host = gatewayProviderBaseHost(settings.gateway_host);
  const port = settings.gateway_port || "8436";
  return [
    'model_provider = "codex_gateway"',
    "",
    "[model_providers.codex_gateway]",
    'name = "OpenAI"',
    `base_url = "http://${host}:${port}/v1"`,
    'wire_api = "responses"',
    "supports_websockets = true",
    ""
  ].join("\n");
}

function gatewayProviderBaseHost(host) {
  const value = String(host || "").trim();
  if (!value || value === "0.0.0.0") return "localhost";
  return value;
}

function replaceGatewayProviderBlock(current, block) {
  let next = String(current || "");
  if (/^\s*model_provider\s*=\s*"codex_gateway"\s*$/m.test(next)) {
    next = next.replace(/^\s*model_provider\s*=\s*"codex_gateway"\s*\r?\n?/m, "");
  }
  next = next.replace(/\r?\n?\[model_providers\.codex_gateway\]\r?\n(?:[^\[\r\n].*\r?\n?)*/m, "\n");
  next = next.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return insertProviderBlockIntoConfig(next, block);
}

function insertProviderBlockIntoConfig(current, block) {
  const normalizedBlock = `${String(block || "").trimEnd()}\n`;
  const text = String(current || "");
  if (!text.trim()) return normalizedBlock;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const insertIndex = lines.findIndex((line) => line.trim() === "");
  if (insertIndex < 0) {
    return `${text.trimEnd()}${newline}${newline}${normalizedBlock.replace(/\n/g, newline)}`;
  }
  const before = lines.slice(0, insertIndex).join(newline);
  const after = lines.slice(insertIndex + 1).join(newline).replace(/^\r?\n/, "");
  return `${before}${newline}${newline}${normalizedBlock.replace(/\n/g, newline)}${newline}${after}`;
}

function removeGatewayProviderConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return false;
  const current = fs.readFileSync(file, "utf8");
  const next = withoutGatewayProvider(current);
  if (next === current) return false;
  writeFilesTransaction([{ file, content: next }], () => {
    if (hasGatewayProvider(readText(file))) throw new Error("移除 Codex Gateway Provider 后校验失败。");
  });
  return true;
}

function withoutGatewayProvider(current) {
  let next = String(current || "")
    .replace(/^\s*model_provider\s*=\s*"codex_gateway"\s*\r?\n?/m, "")
    .replace(/\r?\n?\[model_providers\.codex_gateway\]\r?\n(?:[^\[\r\n].*\r?\n?)*/m, "\n");
  next = next.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return next;
}

function detectCodexAuthMode(settings, accounts) {
  const auth = readJsonSafe(authPath());
  const config = fs.existsSync(configPath()) ? fs.readFileSync(configPath(), "utf8") : "";
  const localKey = String(settings.gateway_api_key || "").trim();
  const authKey = String(auth?.OPENAI_API_KEY || "").trim();
  if (authKey && localKey && authKey === localKey && hasGatewayProvider(config)) {
    return { mode: "gateway", accountId: "" };
  }

  const tokens = auth?.tokens || {};
  const tokenAccountId = String(tokens.account_id || "").trim();
  const refreshToken = String(tokens.refresh_token || "").trim();
  const accessToken = String(tokens.access_token || "").trim();
  if (auth?.auth_mode === "chatgpt" || refreshToken || accessToken || tokenAccountId) {
    const account = accounts.find((item) => {
      return (refreshToken && item.refresh_token === refreshToken)
        || (accessToken && item.access_token === accessToken)
        || (tokenAccountId && (item.account_id === tokenAccountId || item.workspace_id === tokenAccountId));
    });
    if (account) return { mode: "account", accountId: account.id };
  }

  return { mode: "unknown", accountId: "" };
}

function repairConfigSpacing() {
  const file = configPath();
  if (!fs.existsSync(file)) return false;
  const current = fs.readFileSync(file, "utf8");
  const next = current.replace(/("gpt-[^"\r\n]+"\s*=\s*"[^"\r\n]+")\s+(model_provider\s*=)/g, "$1\n$2");
  if (next === current) return false;
  writeFilesTransaction([{ file, content: next }]);
  return true;
}

function hasGatewayProvider(config) {
  return /^\s*model_provider\s*=\s*"codex_gateway"\s*$/m.test(config)
    || /^\s*\[model_providers\.codex_gateway\]\s*$/m.test(config);
}

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function ensureCodexDir() {
  fs.mkdirSync(codexDir(), { recursive: true });
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFilesTransaction(entries, verify = () => {}) {
  const transactionId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staged = entries.map(({ file, content }) => ({
    file,
    content,
    temp: `${file}.tmp-${transactionId}`,
    backup: `${file}.bak-${transactionId}`,
    existed: fs.existsSync(file),
    installed: false
  }));
  let committed = false;
  try {
    for (const entry of staged) {
      fs.mkdirSync(path.dirname(entry.file), { recursive: true });
      fs.writeFileSync(entry.temp, entry.content, { encoding: "utf8", mode: 0o600 });
    }
    for (const entry of staged) {
      if (entry.existed) fs.renameSync(entry.file, entry.backup);
      fs.renameSync(entry.temp, entry.file);
      entry.installed = true;
    }
    verify();
    committed = true;
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      if (entry.installed) fs.rmSync(entry.file, { force: true });
      if (entry.existed && fs.existsSync(entry.backup)) fs.renameSync(entry.backup, entry.file);
    }
    throw error;
  } finally {
    for (const entry of staged) fs.rmSync(entry.temp, { force: true });
    if (committed) {
      for (const entry of staged) {
        try {
          fs.rmSync(entry.backup, { force: true });
        } catch {
          // A stale backup is safer than rolling back files that already passed verification.
        }
      }
    }
  }
}

function toIso(value) {
  if (!value) return "";
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

module.exports = {
  applyGatewayMode,
  applyAccountMode,
  ensureProviderConfig,
  gatewayProviderBlock,
  gatewayProviderBaseHost,
  insertProviderBlockIntoConfig,
  replaceGatewayProviderBlock,
  nextGatewayConfig,
  withoutGatewayProvider,
  removeGatewayProviderConfig,
  detectCodexAuthMode,
  repairConfigSpacing,
  writeFilesTransaction
};
