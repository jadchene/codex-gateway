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
  if (!apiKey) throw new Error("本地 API Key 为空，无法写入 Codex CLI 认证。");
  writeJson(authPath(), { OPENAI_API_KEY: apiKey });
  const providerChanged = ensureProviderConfig(settings);
  return {
    mode: "gateway",
    authPath: authPath(),
    configPath: configPath(),
    providerChanged
  };
}

function applyAccountMode(account) {
  ensureCodexDir();
  if (!account) throw new Error("请选择一个账号。");
  if (!account.access_token || !account.refresh_token) {
    throw new Error("账号 token 不完整，无法写入 Codex CLI 认证。");
  }
  writeJson(authPath(), {
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
  const providerRemoved = removeGatewayProviderConfig();
  return {
    mode: "account",
    accountId: account.id,
    authPath: authPath(),
    configPath: configPath(),
    providerRemoved
  };
}

function ensureProviderConfig(settings) {
  ensureCodexDir();
  const file = configPath();
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const block = gatewayProviderBlock(settings);
  if (/^\s*\[model_providers\.codex_gateway\]\s*$/m.test(current)) {
    const next = replaceGatewayProviderBlock(current, block);
    if (next !== current) {
      fs.writeFileSync(file, next, "utf8");
      return true;
    }
    return false;
  }
  if (/^\s*model_provider\s*=/m.test(current) || /^\s*\[model_providers\./m.test(current)) {
    return false;
  }
  fs.writeFileSync(file, insertProviderBlockIntoConfig(current, block), "utf8");
  return true;
}

function gatewayProviderBlock(settings) {
  const host = settings.gateway_host || "localhost";
  const port = settings.gateway_port || "8436";
  return [
    'model_provider = "codex_gateway"',
    "",
    "[model_providers.codex_gateway]",
    'name = "OpenAI"',
    `base_url = "http://${host}:${port}/v1"`,
    'wire_api = "responses"',
    ""
  ].join("\n");
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
  let next = current
    .replace(/^\s*model_provider\s*=\s*"codex_gateway"\s*\r?\n?/m, "")
    .replace(/\r?\n?\[model_providers\.codex_gateway\]\r?\n(?:[^\[\r\n].*\r?\n?)*/m, "\n");
  next = next.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  if (next === current) return false;
  fs.writeFileSync(file, next, "utf8");
  return true;
}

function detectCodexAuthMode(settings, accounts) {
  repairConfigSpacing();
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
  fs.writeFileSync(file, next, "utf8");
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

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  insertProviderBlockIntoConfig,
  replaceGatewayProviderBlock,
  removeGatewayProviderConfig,
  detectCodexAuthMode,
  repairConfigSpacing
};
