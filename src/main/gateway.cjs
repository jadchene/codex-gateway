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
  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, { ok: true });
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
    if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
      return sendJson(res, 200, estimateTokenCount(incomingBody));
    }
    const request = buildGatewayRequest(settings.upstream_base_url, req.url, incomingBody);
    const firstAccount = pickGatewayAccount(store.listAccounts());
    if (!firstAccount) {
      return sendJson(res, 503, { error: { message: "No enabled GPT account with an access token is available." } });
    }
    let result = await callUpstream(req, request.body, request.upstreamUrl, firstAccount, settings);
    let account = firstAccount;
    if (isQuotaExhaustedResponse(result.status, result.body) && hooks.refreshAllUsage) {
      store.addAppLog({
        level: "warn",
        scope: "gateway",
        action: "quota-failover",
        status: String(result.status),
        message: `${pathname} 触发额度/限流信号，刷新全部账号后重试`
      });
      await hooks.refreshAllUsage("gateway-quota-failover");
      const nextAccount = pickGatewayAccount(store.listAccounts(), [account.id]);
      if (nextAccount) {
        account = nextAccount;
        result = await callUpstream(req, request.body, request.upstreamUrl, account, settings);
        result.retried = true;
      }
    }
    writeUpstreamResponse(res, result);
    store.addTokenLog({
      account_id: account.id,
      method: req.method,
      path: request.path,
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

async function callUpstream(req, body, upstreamUrl, account, settings) {
  const timeoutMs = Number(settings.request_timeout_ms || 0);
  const controller = Number.isFinite(timeoutMs) && timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, account.access_token),
      body: body.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
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

function buildGatewayRequest(baseUrl, requestUrl, body) {
  const parsed = new URL(requestUrl, "http://localhost");
  let path = parsed.pathname;
  let nextBody = body;
  if (path === "/v1/chat/completions") {
    path = "/v1/responses";
    nextBody = adaptChatCompletionsToResponses(body);
  } else if (path === "/v1/images/generations" || path === "/v1/images/edits") {
    path = "/v1/responses";
    nextBody = adaptImagesToResponses(body, parsed.pathname);
  }
  const upstreamUrl = buildUpstreamUrl(baseUrl, `${path}${parsed.search}`);
  return { upstreamUrl, body: nextBody, path };
}

function adaptChatCompletionsToResponses(body) {
  const value = parseJsonBuffer(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) return body;
  const next = {
    model: value.model,
    input: value.input || chatMessagesToInput(value.messages),
    stream: Boolean(value.stream)
  };
  copyKnown(value, next, [
    "tools",
    "tool_choice",
    "temperature",
    "top_p",
    "metadata",
    "parallel_tool_calls",
    "reasoning",
    "store"
  ]);
  if (value.max_tokens || value.max_completion_tokens) {
    next.max_output_tokens = value.max_tokens || value.max_completion_tokens;
  }
  return Buffer.from(JSON.stringify(next), "utf8");
}

function chatMessagesToInput(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => ({
    role: message.role || "user",
    content: message.content || ""
  }));
}

function adaptImagesToResponses(body, originalPath) {
  const value = parseJsonBuffer(body) || {};
  const prompt = value.prompt || value.input || "";
  const imageTool = {
    type: "image_generation",
    model: value.image_model || "gpt-image-2"
  };
  if (value.size) imageTool.size = value.size;
  if (value.quality) imageTool.quality = value.quality;
  if (value.n) imageTool.n = value.n;
  const next = {
    model: value.model && value.model !== "gpt-image-2" ? value.model : "gpt-5",
    input: originalPath.endsWith("/edits") ? buildImageEditInput(value, prompt) : prompt,
    tools: [imageTool],
    stream: Boolean(value.stream)
  };
  return Buffer.from(JSON.stringify(next), "utf8");
}

function buildImageEditInput(value, prompt) {
  const items = [{ type: "input_text", text: prompt }];
  if (value.image) items.push({ type: "input_image", image_url: value.image });
  if (value.mask) items.push({ type: "input_image", image_url: value.mask });
  return [{ role: "user", content: items }];
}

function estimateTokenCount(body) {
  const value = parseJsonBuffer(body) || {};
  const text = JSON.stringify(value.messages || value.input || value);
  const inputTokens = Math.max(1, Math.ceil(text.length / 4));
  return { input_tokens: inputTokens, total_tokens: inputTokens };
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
  const total = emptyUsage();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const usage = parseUsageJson(payload);
    if (hasUsage(usage)) mergeUsage(total, usage);
  }
  return total;
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

function buildUpstreamHeaders(headers, accessToken) {
  const outgoing = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "authorization"].includes(lower)) continue;
    outgoing[key] = value;
  }
  outgoing.authorization = `Bearer ${accessToken}`;
  outgoing.accept = outgoing.accept || "application/json, text/event-stream";
  return outgoing;
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
  isQuotaExhaustedResponse
};
