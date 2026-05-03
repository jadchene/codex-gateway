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
    return handleHealth(req, res, store, settings, hooks);
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
    writeUpstreamResponse(res, applyResponseAdapter(request, result));
    store.addTokenLog({
      account_id: account.id,
      method: req.method,
      request_path: request.originalPath,
      upstream_path: pathFromUrl(request.upstreamUrl),
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

async function handleHealth(req, res, store, settings, hooks) {
  const account = pickGatewayAccount(store.listAccounts());
  if (!account) {
    return sendJson(res, 503, { ok: false, error: "No enabled GPT account with an access token is available." });
  }
  try {
    const request = {
      path: "/v1/models",
      upstreamUrl: buildUpstreamUrl(settings.upstream_base_url, "/v1/models"),
      body: Buffer.alloc(0)
    };
    const { result } = await callWithFailover(
      { method: "GET", headers: { accept: "application/json" } },
      request,
      account,
      settings,
      store,
      hooks
    );
    if (result.status >= 200 && result.status < 300) {
      return sendJson(res, 200, { ok: true, upstream_status: result.status });
    }
    res.statusCode = result.status;
    for (const [key, value] of result.headers) {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    return res.end(result.body);
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: String(error?.message || error) });
  }
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

function applyResponseAdapter(request, result) {
  if (request.responseAdapter?.type !== "images" || result.status < 200 || result.status >= 300) return result;
  const converted = convertResponsesToImages(result.body, request.responseAdapter);
  if (!converted) return result;
  return {
    ...result,
    headers: [["content-type", request.responseAdapter.stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8"]],
    body: converted
  };
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
  let path = parsed.pathname;
  let nextBody = body;
  let responseAdapter = null;
  if (path === "/v1/chat/completions") {
    path = "/v1/responses";
    nextBody = adaptChatCompletionsToResponses(body);
  } else if (path === "/v1/images/generations" || path === "/v1/images/edits") {
    path = "/v1/responses";
    const adapted = adaptImagesToResponses(body, parsed.pathname, getHeader(headers, "content-type"));
    nextBody = adapted.body;
    responseAdapter = adapted.responseAdapter;
  }
  const upstreamUrl = buildUpstreamUrl(baseUrl, `${path}${parsed.search}`);
  return { upstreamUrl, body: nextBody, path, originalPath: `${parsed.pathname}${parsed.search}`, responseAdapter };
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
    "temperature",
    "top_p",
    "metadata",
    "parallel_tool_calls",
    "reasoning",
    "store"
  ]);
  const tools = normalizeChatTools(value.tools);
  if (tools) next.tools = tools;
  const toolChoice = normalizeChatToolChoice(value.tool_choice);
  if (toolChoice !== undefined) next.tool_choice = toolChoice;
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

function normalizeChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    if (tool.type === "function" && tool.function && typeof tool.function === "object") {
      const next = {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters
      };
      if (tool.function.strict !== undefined) next.strict = tool.function.strict;
      return removeUndefined(next);
    }
    return tool;
  });
}

function normalizeChatToolChoice(toolChoice) {
  if (toolChoice === undefined) return undefined;
  if (!toolChoice || typeof toolChoice !== "object") return toolChoice;
  if (toolChoice.type === "function" && toolChoice.function?.name) {
    return { type: "function", name: toolChoice.function.name };
  }
  return toolChoice;
}

function adaptImagesToResponses(body, originalPath, contentType = "") {
  const value = originalPath.endsWith("/edits") && String(contentType).toLowerCase().startsWith("multipart/form-data")
    ? parseImagesEditMultipart(body, contentType)
    : parseJsonBuffer(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid images request JSON`);
  }
  const prompt = String(value.prompt || "").trim();
  if (!prompt) throw new Error("Invalid request: prompt is required");
  const responseFormat = normalizeImagesResponseFormat(value.response_format);
  const imageTool = buildImageTool(value);
  const inputImages = originalPath.endsWith("/edits") ? extractEditImages(value) : [];
  if (originalPath.endsWith("/edits") && inputImages.length === 0) {
    throw new Error("Invalid request: image is required");
  }
  if (value.mask) imageTool.input_image_mask = { image_url: normalizeMaskImage(value.mask) };
  const next = {
    model: "gpt-5",
    instructions: "",
    input: buildImagesInput(prompt, inputImages),
    tools: [imageTool],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
    reasoning: { effort: "medium", summary: "auto" },
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    metadata: {
      codex_gateway_original_path: originalPath,
      codex_gateway_client_stream: Boolean(value.stream)
    }
  };
  return {
    body: Buffer.from(JSON.stringify(next), "utf8"),
    responseAdapter: {
      type: "images",
      responseFormat,
      stream: Boolean(value.stream)
    }
  };
}

function buildImageTool(value) {
  const tool = {
    type: "image_generation",
    model: String(value.model || value.image_model || "gpt-image-2").trim() || "gpt-image-2"
  };
  if (!value.output_format) tool.output_format = "png";
  for (const field of ["size", "quality", "background", "output_format", "output_compression", "partial_images"]) {
    if (value[field] !== undefined && value[field] !== null && value[field] !== "") tool[field] = value[field];
  }
  return tool;
}

function buildImagesInput(prompt, images) {
  const content = [{ type: "input_text", text: prompt }];
  for (const imageUrl of images) content.push({ type: "input_image", image_url: imageUrl });
  return [{ type: "message", role: "user", content }];
}

function normalizeImagesResponseFormat(value) {
  return String(value || "").trim().toLowerCase() === "url" ? "url" : "b64_json";
}

function extractEditImages(value) {
  const raw = value.images !== undefined ? value.images : value.image;
  const images = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return images.map((item) => normalizeImageValue(item, "image")).filter(Boolean);
}

function normalizeImageValue(item, field) {
  if (typeof item === "string") return validateImageUrl(item, field);
  if (!item || typeof item !== "object") return "";
  if (item.file_id) throw new Error(`Invalid request: ${field}.file_id is not supported (use image_url)`);
  return validateImageUrl(item.image_url || "", `${field}.image_url`);
}

function normalizeMaskImage(mask) {
  if (typeof mask === "string") return validateImageUrl(mask, "mask");
  if (!mask || typeof mask !== "object") throw new Error("Invalid request: mask.image_url is required");
  if (mask.file_id) throw new Error("Invalid request: mask.file_id is not supported (use mask.image_url)");
  return validateImageUrl(mask.image_url || "", "mask.image_url");
}

function validateImageUrl(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Invalid request: ${field} is required`);
  if (!text.toLowerCase().startsWith("data:")) return text;
  if (!text.includes(";base64,")) throw new Error(`Invalid request: ${field} must be a base64 data URL`);
  const b64 = text.split(";base64,")[1] || "";
  try {
    Buffer.from(b64, "base64");
  } catch {
    throw new Error(`Invalid request: ${field} contains invalid base64 image data`);
  }
  return text;
}

function parseImagesEditMultipart(body, contentType) {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new Error("Invalid multipart request: missing boundary");
  const parts = parseMultipartForm(body, boundary);
  const value = { images: [] };
  for (const part of parts) {
    if (part.name === "prompt") value.prompt = part.data.toString("utf8").trim();
    else if (part.name === "image" || part.name === "image[]") value.images.push(dataUrlFromMultipartPart(part));
    else if (part.name === "mask") value.mask = dataUrlFromMultipartPart(part);
    else if (["model", "size", "quality", "background", "output_format", "response_format"].includes(part.name)) {
      value[part.name] = part.data.toString("utf8").trim();
    } else if (["output_compression", "partial_images"].includes(part.name)) {
      const number = Number(part.data.toString("utf8").trim());
      if (Number.isFinite(number)) value[part.name] = number;
    } else if (part.name === "stream") {
      value.stream = part.data.toString("utf8").trim().toLowerCase() === "true";
    }
  }
  return value;
}

function multipartBoundary(contentType) {
  return String(contentType || "").split(";").map((item) => item.trim()).find((item) => item.startsWith("boundary="))?.slice(9).replace(/^"|"$/g, "");
}

function parseMultipartForm(body, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  for (const section of splitBuffer(body, marker).slice(1)) {
    let chunk = trimBufferPrefix(section, Buffer.from("\r\n"));
    if (chunk.subarray(0, 2).toString() === "--") break;
    const headerEnd = indexOfBuffer(chunk, Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;
    const headersText = chunk.subarray(0, headerEnd).toString("utf8");
    let data = chunk.subarray(headerEnd + 4);
    data = trimBufferSuffix(data, Buffer.from("\r\n"));
    data = trimBufferSuffix(data, Buffer.from("--"));
    const headers = Object.fromEntries(headersText.split(/\r?\n/).map((line) => {
      const index = line.indexOf(":");
      return index >= 0 ? [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()] : ["", ""];
    }).filter(([key]) => key));
    const disposition = headers["content-disposition"] || "";
    const name = disposition.split(";").map((item) => item.trim()).find((item) => item.startsWith("name="))?.slice(5).replace(/^"|"$/g, "");
    if (name) parts.push({ name, contentType: headers["content-type"] || "image/png", data });
  }
  if (parts.length === 0) throw new Error("Invalid multipart request: no form parts found");
  return parts;
}

function splitBuffer(buffer, marker) {
  const parts = [];
  let start = 0;
  let index = indexOfBuffer(buffer.subarray(start), marker);
  while (index >= 0) {
    parts.push(buffer.subarray(start, start + index));
    start += index + marker.length;
    index = indexOfBuffer(buffer.subarray(start), marker);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function indexOfBuffer(buffer, needle) {
  return buffer.indexOf(needle);
}

function trimBufferPrefix(buffer, prefix) {
  return buffer.subarray(0, prefix.length).equals(prefix) ? buffer.subarray(prefix.length) : buffer;
}

function trimBufferSuffix(buffer, suffix) {
  return buffer.subarray(Math.max(0, buffer.length - suffix.length)).equals(suffix)
    ? buffer.subarray(0, buffer.length - suffix.length)
    : buffer;
}

function dataUrlFromMultipartPart(part) {
  const mime = String(part.contentType || "image/png").trim() || "image/png";
  return `data:${mime};base64,${part.data.toString("base64")}`;
}

function convertResponsesToImages(body, adapter) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  const events = parseSseJsonEvents(text);
  const response = events.length > 0 ? responseFromImageEvents(events) : parseJsonBuffer(body);
  if (!response || typeof response !== "object") return null;
  const imagesResponse = buildImagesApiResponse(response.response || response, adapter.responseFormat);
  if (adapter.stream) return imagesApiResponseToSse(imagesResponse);
  return Buffer.from(JSON.stringify(imagesResponse), "utf8");
}

function parseSseJsonEvents(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines = block.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) continue;
    const payload = dataLines.map((line) => line.slice(5).trim()).join("\n");
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // Ignore malformed upstream SSE chunks and fall back to what can be parsed.
    }
  }
  return events;
}

function responseFromImageEvents(events) {
  const output = [];
  let completed = null;
  for (const event of events) {
    if (event.type === "response.output_item.done" && event.item) output.push(event.item);
    if (event.type === "response.image_generation_call.partial_image" && event.partial_image_b64) {
      output.push({
        type: "image_generation_call",
        status: "completed",
        output_format: event.output_format,
        result: event.partial_image_b64
      });
    }
    if (event.type === "response.completed" && event.response) completed = event.response;
  }
  if (completed) {
    const existing = Array.isArray(completed.output) ? completed.output : [];
    return { ...completed, output: existing.length > 0 ? existing : output };
  }
  return { output };
}

function buildImagesApiResponse(response, responseFormat) {
  const results = collectImageGenerationResults(response);
  const out = {
    created: imageCreatedTimestamp(response),
    data: dedupeImageResults(results).map((item) => imageResultPayload(item, responseFormat))
  };
  const first = results[0] || {};
  for (const field of ["background", "output_format", "quality", "size"]) {
    if (first[field]) out[field] = first[field];
  }
  const usage = response.tool_usage?.image_gen || response.usage;
  if (usage) out.usage = usage;
  return out;
}

function collectImageGenerationResults(value) {
  if (Array.isArray(value)) return value.flatMap(collectImageGenerationResults);
  if (!value || typeof value !== "object") return [];
  const results = [];
  if (value.type === "image_generation_call" && value.result) {
    results.push({
      result: String(value.result),
      revised_prompt: stringField(value, "revised_prompt"),
      output_format: stringField(value, "output_format"),
      size: stringField(value, "size"),
      background: stringField(value, "background"),
      quality: stringField(value, "quality")
    });
  }
  for (const field of ["response", "output", "item", "output_item"]) {
    if (value[field]) results.push(...collectImageGenerationResults(value[field]));
  }
  return results;
}

function dedupeImageResults(results) {
  const seen = new Set();
  return results.filter((item) => {
    if (seen.has(item.result)) return false;
    seen.add(item.result);
    return true;
  });
}

function imageResultPayload(result, responseFormat) {
  const payload = {};
  if (responseFormat === "url") {
    payload.url = `data:${mimeTypeFromImageFormat(result.output_format)};base64,${result.result}`;
  } else {
    payload.b64_json = result.result;
  }
  if (result.revised_prompt) payload.revised_prompt = result.revised_prompt;
  return payload;
}

function imagesApiResponseToSse(response) {
  const chunks = [];
  for (const item of response.data || []) {
    const payload = { ...item, type: "image_generation.completed" };
    if (response.usage) payload.usage = response.usage;
    chunks.push(`event: image_generation.completed\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  return Buffer.from(`${chunks.join("")}data: [DONE]\n\n`, "utf8");
}

function imageCreatedTimestamp(value) {
  const created = Number(value.created_at || value.created);
  return Number.isFinite(created) && created > 0 ? Math.trunc(created) : Math.floor(Date.now() / 1000);
}

function stringField(value, field) {
  const text = String(value[field] || "").trim();
  return text || undefined;
}

function mimeTypeFromImageFormat(format) {
  const normalized = String(format || "png").trim().toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "webp") return "image/webp";
  return "image/png";
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

function getHeader(headers, name) {
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === lower);
  return key ? headers[key] : "";
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
  applyResponseAdapter,
  buildUpstreamUrl,
  buildUpstreamHeaders,
  buildGatewayRequest,
  isQuotaExhaustedResponse,
  isAuthExpiredResponse
};
