const http = require("node:http");
const { pickGatewayAccount } = require("./selection.cjs");

function createGateway(store, authService, hooks = {}) {
  let server = null;
  let state = { running: false, url: "", error: "" };

  async function start() {
    if (server) return state;
    const settings = store.getSettings();
    const host = settings.gateway_host || "127.0.0.1";
    const port = Number(settings.gateway_port || 1455);
    server = http.createServer((req, res) => handleRequest(req, res, store, authService, hooks));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    state = { running: true, url: `http://${host}:${port}`, error: "" };
    return state;
  }

  async function stop() {
    if (!server) {
      state = { running: false, url: "", error: "" };
      return state;
    }
    const closing = server;
    server = null;
    await new Promise((resolve) => closing.close(resolve));
    state = { running: false, url: "", error: "" };
    return state;
  }

  function status() {
    return state;
  }

  return { start, stop, status };
}

async function handleRequest(req, res, store, authService, hooks) {
  const started = Date.now();
  const settings = store.getSettings();
  const parsedUrl = new URL(req.url, "http://localhost");
  const pathname = parsedUrl.pathname;
  if (req.method === "GET" && pathname === "/auth/callback") {
    return handleAuthCallback(parsedUrl, res, authService);
  }
  if (!pathname.startsWith("/v1/")) {
    return sendJson(res, 404, { error: { message: "Only /v1/* gateway routes are supported." } });
  }
  const auth = req.headers.authorization || "";
  const localKey = settings.gateway_api_key || "";
  if (localKey && auth !== `Bearer ${localKey}`) {
    return sendJson(res, 401, { error: { message: "Invalid local gateway API key." } });
  }

  try {
    const incomingBody = await readBody(req);
    const request = buildGatewayRequest(settings.upstream_base_url, req.url, incomingBody, req.headers);
    const firstAccount = pickGatewayAccount(store.listAccounts());
    if (!firstAccount) {
      return sendJson(res, 503, { error: { message: "No enabled GPT account with an access token is available." } });
    }
    const { account, result } = await callWithFailover(req, request, firstAccount, settings, store, hooks, started);
    writeUpstreamResponse(res, result);
    store.addTokenLog({
      account_id: account.id,
      method: req.method,
      request_path: request.originalPath,
      upstream_path: pathFromUrl(request.upstreamUrl),
      session_id: headerValue(req.headers.session_id),
      version: headerValue(req.headers.version),
      status: result.status,
      duration_ms: Date.now() - started,
      ...result.tokenUsage,
      message: null
    });
  } catch (error) {
    const message = error?.name === "AbortError" ? "Upstream request timed out." : String(error?.message || error);
    store.addAppLog({
      level: "error",
      scope: "gateway",
      action: "request",
      status: "failed",
      message
    });
    sendJson(res, 502, { error: { message } });
  }
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value ? String(value) : "";
}

async function callWithFailover(req, request, firstAccount, settings, store, hooks) {
  const excluded = new Set();
  let account = firstAccount;
  let lastResult = null;
  let refreshedUsage = false;
  for (let attempt = 0; attempt < 8 && account; attempt += 1) {
    let result = await callUpstream(req, request, account, settings);
    if (isAuthExpiredResponse(result.status, result.body) && hooks.refreshAccountToken) {
      try {
        const refreshed = await hooks.refreshAccountToken(account.id);
        account = refreshed || account;
        result = await callUpstream(req, request, account, settings);
        result.retried = true;
      } catch (error) {
        store.addAppLog({
          level: "warn",
          scope: "gateway",
          action: "refresh-token",
          status: "failed",
          message: `${request.path} 刷新账号 token 失败：${account.email || account.name || account.id}: ${error.message}`
        });
      }
    }
    if (!isQuotaExhaustedResponse(result.status, result.body)) {
      return { account, result };
    }
    lastResult = result;
    excluded.add(account.id);
    if (!refreshedUsage && hooks.refreshAllUsage) {
      refreshedUsage = true;
      store.addAppLog({
        level: "warn",
        scope: "gateway",
        action: "quota-failover",
        status: String(result.status),
        message: `${request.path} 触发额度/限流信号，刷新全部账号后切换账号重试`
      });
      await hooks.refreshAllUsage("gateway-quota-failover");
    }
    account = pickGatewayAccount(store.listAccounts(), Array.from(excluded));
  }
  return { account: firstAccount, result: lastResult };
}

async function callUpstream(req, request, account, settings) {
  const timeoutMs = Number(settings.request_timeout_ms || 0);
  const controller = Number.isFinite(timeoutMs) && timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const hasBody = request.body.length > 0 && req.method !== "GET" && req.method !== "HEAD";
  try {
    const upstream = await fetch(request.upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, account, hasBody, request.path),
      body: hasBody ? request.body : undefined,
      signal: controller?.signal
    });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    const headers = [];
    upstream.headers.forEach((value, key) => headers.push([key, value]));
    return { status: upstream.status, headers, body: responseBody, tokenUsage: extractTokenUsage(responseBody) };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function writeUpstreamResponse(res, result) {
  res.statusCode = result.status;
  for (const [key, value] of result.headers) {
    if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  }
  res.end(result.body);
}

function isQuotaExhaustedResponse(status, body) {
  if (![400, 403, 429].includes(Number(status))) return false;
  const text = Buffer.isBuffer(body) ? body.toString("utf8", 0, Math.min(body.length, 4096)) : String(body || "");
  const normalized = text.toLowerCase();
  return normalized.includes("rate_limit")
    || normalized.includes("limit_reached")
    || normalized.includes("usage_limit")
    || normalized.includes("quota")
    || normalized.includes("insufficient_quota")
    || normalized.includes("too many requests")
    || normalized.includes("exceeded");
}

function isAuthExpiredResponse(status, body) {
  if (![401, 403].includes(Number(status))) return false;
  const text = Buffer.isBuffer(body) ? body.toString("utf8", 0, Math.min(body.length, 4096)) : String(body || "");
  const normalized = text.toLowerCase();
  return Number(status) === 401
    || normalized.includes("invalid_token")
    || normalized.includes("expired")
    || normalized.includes("unauthorized")
    || normalized.includes("authentication");
}

function buildGatewayRequest(baseUrl, requestUrl, body, headers = {}) {
  const parsed = new URL(requestUrl, "http://localhost");
  const path = parsed.pathname;
  const upstreamUrl = buildUpstreamUrl(baseUrl, `${path}${parsed.search}`);
  return { upstreamUrl, body, path, originalPath: `${parsed.pathname}${parsed.search}` };
}

function parseJsonBuffer(body) {
  try {
    return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body || ""));
  } catch {
    return null;
  }
}

function copyKnown(source, target, keys) {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function extractTokenUsage(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  if (!text.trim()) return emptyUsage();
  const direct = parseUsageJson(text);
  if (hasUsage(direct)) return direct;
  return parseUsageSse(text);
}

function parseUsageJson(text) {
  try {
    const json = JSON.parse(text);
    return usageFromObject(json);
  } catch {
    return emptyUsage();
  }
}

function parseUsageSse(text) {
  let latest = emptyUsage();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const usage = parseUsageJson(payload);
    if (hasUsage(usage)) latest = usage;
  }
  return latest;
}

function usageFromObject(value) {
  const usage = findUsage(value);
  if (!usage) return emptyUsage();
  const input = numberFrom(usage.input_tokens, usage.prompt_tokens);
  const output = numberFrom(usage.output_tokens, usage.completion_tokens);
  const cached = numberFrom(
    usage.cached_input_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_tokens
  );
  const reasoning = numberFrom(
    usage.reasoning_output_tokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.completion_tokens_details?.reasoning_tokens
  );
  const total = numberFrom(usage.total_tokens, input + output);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total
  };
}

function findUsage(value) {
  if (!value || typeof value !== "object") return null;
  if (value.usage && typeof value.usage === "object") return value.usage;
  if (value.response?.usage && typeof value.response.usage === "object") return value.response.usage;
  if (value.type && String(value.type).includes("usage") && ("input_tokens" in value || "output_tokens" in value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const usage = findUsage(item);
      if (usage) return usage;
    }
  }
  return null;
}

function mergeUsage(target, usage) {
  target.input_tokens += usage.input_tokens;
  target.cached_input_tokens += usage.cached_input_tokens;
  target.output_tokens += usage.output_tokens;
  target.reasoning_output_tokens += usage.reasoning_output_tokens;
  target.total_tokens += usage.total_tokens;
}

function hasUsage(usage) {
  return usage.input_tokens > 0 || usage.cached_input_tokens > 0 || usage.output_tokens > 0 || usage.total_tokens > 0;
}

function numberFrom(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(0, Math.trunc(number));
  }
  return 0;
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}

async function handleAuthCallback(parsedUrl, res, authService) {
  if (!authService) return sendHtml(res, 500, "Codex Gateway", "登录服务未初始化。");
  try {
    await authService.completeCallback(parsedUrl.searchParams);
    return sendHtml(res, 200, "登录成功", "账号已保存，可以关闭这个浏览器页面并回到 Codex Gateway。");
  } catch (error) {
    return sendHtml(res, 500, "登录失败", String(error?.message || error));
  }
}

function buildUpstreamUrl(baseUrl, requestUrl) {
  const base = String(baseUrl || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
  const parsed = new URL(requestUrl, "http://localhost");
  const gatewayPath = parsed.pathname;
  const upstreamPath = gatewayPath.replace(/^\/v1/, "");
  return `${base}${upstreamPath}${parsed.search}`;
}

function pathFromUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(value || "");
  }
}

function buildUpstreamHeaders(headers, account, hasBody = false, path = "") {
  const outgoing = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "authorization"].includes(lower)) continue;
    outgoing[key] = value;
  }
  setHeader(outgoing, "Authorization", `Bearer ${account.access_token}`);
  const accountHeader = account.account_id || account.workspace_id || "";
  if (accountHeader) setHeader(outgoing, "ChatGPT-Account-ID", accountHeader);
  return outgoing;
}

function setHeader(headers, name, value) {
  const lower = name.toLowerCase();
  const existing = Object.keys(headers).find((item) => item.toLowerCase() === lower);
  if (existing) {
    headers[existing] = value;
  } else {
    headers[name] = value;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, title, message) {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;padding:40px"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

module.exports = {
  createGateway,
  buildUpstreamUrl,
  buildUpstreamHeaders,
  buildGatewayRequest,
  extractTokenUsage,
  isQuotaExhaustedResponse,
  isAuthExpiredResponse
};
