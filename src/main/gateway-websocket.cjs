const { WebSocket, WebSocketServer } = require("ws");
const { randomUUID } = require("node:crypto");
const { bridgeWebSockets } = require("./gateway-websocket-relay.cjs");
const { createWebSocketObserver } = require("./gateway-websocket-observer.cjs");

const DEFAULT_CONNECT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_ERROR_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;
const DEFAULT_BUFFER_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 1000;

const WEBSOCKET_ROUTES = new Set([
  "/v1/responses",
  "/v1/realtime"
]);

const BLOCKED_CLIENT_RESPONSE_HEADERS = new Set([
  "connection",
  "upgrade",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "content-length",
  "transfer-encoding",
  "x-codex-primary-used-percent",
  "x-codex-primary-window-minutes",
  "x-codex-primary-reset-after-seconds",
  "x-codex-secondary-used-percent",
  "x-codex-secondary-window-minutes",
  "x-codex-secondary-reset-after-seconds",
  "x-codex-plan-type",
  "x-codex-active-limit",
  "x-codex-credits-balance",
  "x-codex-credits-has-credits",
  "x-codex-credits-unlimited"
]);

const SEMANTIC_CLIENT_RESPONSE_HEADERS = new Set([
  "x-codex-turn-state",
  "x-models-etag",
  "x-reasoning-included",
  "openai-model"
]);

/**
 * Creates the WebSocket half of the local gateway. The downstream upgrade is
 * accepted only after an upstream account has completed its own handshake.
 */
function createGatewayWebSocketGateway(options) {
  const { store, hooks = {}, runtime, helpers } = options;
  const maxPayloadBytes = positiveSetting(store.getSettings().gateway_websocket_max_payload_bytes, DEFAULT_MAX_PAYLOAD_BYTES);
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: true,
    maxPayload: maxPayloadBytes,
    handleProtocols(_protocols, request) {
      return request.gatewaySelectedProtocol || false;
    }
  });

  server.on("headers", (headers, request) => {
    for (const header of request.gatewayResponseHeaders || []) headers.push(header);
  });

  async function handleUpgrade(request, socket, head) {
    const started = Date.now();
    const connectionId = randomUUID();
    const settings = store.getSettings();
    const parsedUrl = new URL(request.url, "http://localhost");
    if (!WEBSOCKET_ROUTES.has(parsedUrl.pathname)) {
      return rejectUpgrade(socket, 404, "Unrecognized WebSocket request URL.");
    }
    const localKey = settings.gateway_api_key || "";
    if (localKey && request.headers.authorization !== `Bearer ${localKey}`) {
      return rejectUpgrade(socket, 401, "Incorrect API key provided.");
    }
    const maxConcurrentRequests = positiveSetting(settings.gateway_max_concurrent_requests, 16);
    if (runtime.activeRequests.size >= maxConcurrentRequests) {
      return rejectUpgrade(socket, 503, "The gateway has reached its concurrent request limit.");
    }

    const routeContext = runtime.routing.context(request.headers);
    if (routeContext.unknownTurnState) {
      return rejectUpgrade(socket, 409, "The gateway cannot safely route this existing turn state.");
    }
    const accounts = store.listAccounts();
    const firstAccount = selectFirstAccount(runtime.routing, routeContext, accounts);
    if (!firstAccount) {
      const message = routeContext.established
        ? "The account assigned to this Codex session is unavailable. Start a new session and try again."
        : "The server is currently unavailable. Please try again later.";
      return rejectUpgrade(socket, 503, message);
    }

    const controller = new AbortController();
    runtime.activeRequests.add(controller);
    const onClientClosed = () => abortController(controller, "client_cancelled", "WebSocket client disconnected.");
    socket.once("close", onClientClosed);
    socket.once("error", onClientClosed);
    let releaseAccountLoad = runtime.routing.beginRequest(firstAccount.id);
    let upstream = null;
    let observer = null;
    try {
      const result = await connectWithFailover({
        request,
        settings,
        store,
        hooks,
        helpers,
        routing: runtime.routing,
        routeContext,
        firstAccount,
        signal: controller.signal
      });
      upstream = result.websocket;
      releaseAccountLoad();
      releaseAccountLoad = runtime.routing.beginRequest(result.account.id);
      helpers.syncAccountUsageFromHeaders(result.account, result.headers, store);
      runtime.routing.observeResponse(routeContext, result.account, result.headers);
      store.saveSettings({ gateway_current_account_id: result.account.id });

      request.gatewaySelectedProtocol = upstream.protocol || "";
      request.gatewayResponseHeaders = responseHeadersForClient(result.headers, settings, store, helpers);
      const downstream = await acceptDownstream(server, request, socket, head, controller.signal);
      observer = createWebSocketObserver({
        store,
        hooks,
        routing: runtime.routing,
        account: result.account,
        request,
        requestPath: `${parsedUrl.pathname}${parsedUrl.search}`,
        upstreamPath: pathFromUrl(result.upstreamUrl),
        helpers,
        settings,
        onIdleTimeout: () => abortController(controller, "websocket_idle_timeout", "Upstream WebSocket response became idle.")
      });
      downstream.once("close", observer.onClose);
      const downstreamClose = waitForWebSocketClose(downstream);
      bridgeWebSockets({
        downstream,
        upstream,
        controller,
        bufferHighWaterBytes: positiveSetting(settings.gateway_websocket_buffer_high_water_bytes, DEFAULT_BUFFER_HIGH_WATER_BYTES),
        onDownstreamMessage: observer.onDownstreamMessage,
        onUpstreamMessage: observer.onUpstreamMessage
      });
      controller.signal.addEventListener("abort", () => {
        const reason = controller.signal.reason;
        if (["client_cancelled", "gateway_shutdown"].includes(reason?.code)) return;
        store.addAppLog?.({
          level: "warn",
          scope: "gateway-websocket",
          action: "relay",
          status: reason?.code || "aborted",
          message: `${parsedUrl.pathname} WebSocket 已中止：${reason?.message || "unknown error"}`
        });
      }, { once: true });
      logOpen(store, parsedUrl, result.account, connectionId, started);
      upstream = null;
      const closeDetail = await downstreamClose;
      logClose(store, parsedUrl, result.account, connectionId, closeDetail, started);
    } catch (error) {
      upstream?.terminate();
      if (!socket.destroyed) {
        const status = Number(error.statusCode || 502);
        rejectUpgrade(socket, status, publicUpgradeError(error));
      }
      logFailure(store, parsedUrl, firstAccount, connectionId, error, started);
    } finally {
      observer?.dispose();
      releaseAccountLoad();
      socket.off("close", onClientClosed);
      socket.off("error", onClientClosed);
      runtime.activeRequests.delete(controller);
    }
  }

  return {
    handleUpgrade,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function selectFirstAccount(routing, routeContext, accounts) {
  if (routeContext.established) return routing.findBoundAccount(routeContext, accounts);
  return routing.findPreferredAccount(routeContext, accounts) || routing.selectNewAccount(accounts);
}

async function connectWithFailover(options) {
  const { request, settings, store, hooks, helpers, routing, routeContext, signal } = options;
  const excluded = new Set();
  const allowFailover = !routeContext.established;
  let account = options.firstAccount;
  let lastError = null;
  while (account) {
    let result;
    try {
      result = await openUpstream(request, account, settings, helpers, signal);
      return { account, ...result };
    } catch (error) {
      let failure = error;
      if (helpers.isAuthExpiredResponse(failure.statusCode, failure.body || Buffer.alloc(0)) && hooks.refreshAccountToken) {
        let refreshedAccount;
        try {
          refreshedAccount = await hooks.refreshAccountToken(account.id) || account;
        } catch (refreshError) {
          store.addAppLog?.({
            level: "warn",
            scope: "gateway-websocket",
            action: "refresh-token",
            status: "failed",
            message: `WebSocket 刷新账号 token 失败：${account.email || account.name || account.id}: ${refreshError.message}`
          });
          throw failure;
        }
        account = refreshedAccount;
        try {
          result = await openUpstream(request, account, settings, helpers, signal);
          return { account, ...result };
        } catch (retryError) {
          failure = retryError;
        }
      }
      lastError = failure;
      const headers = failure.headers || {};
      const body = failure.body || Buffer.alloc(0);
      const syncedUsage = helpers.syncAccountUsageFromHeaders(account, headers, store);
      if (!isWebSocketQuotaFailure(failure, helpers) || !allowFailover) throw failure;
      if (!syncedUsage) {
        routing.setCooldown(account.id, positiveSetting(settings.gateway_quota_cooldown_ms, DEFAULT_QUOTA_COOLDOWN_MS));
        scheduleUsageRefresh(account, hooks, routing, store);
      }
      excluded.add(account.id);
      account = routing.selectNewAccount(store.listAccounts(), Array.from(excluded));
    }
  }
  throw lastError || statusError(503, "No enabled GPT account with an access token is available.");
}

function openUpstream(request, account, settings, helpers, signal) {
  const upstreamUrl = helpers.buildUpstreamUrl(settings.upstream_base_url, request.url);
  const protocols = parseProtocols(request.headers["sec-websocket-protocol"]);
  const headers = buildUpstreamWebSocketHeaders(request.headers, account, request.url, helpers);
  const timeoutMs = positiveSetting(settings.gateway_connect_timeout_ms, DEFAULT_CONNECT_TIMEOUT_MS);
  const errorLimit = positiveSetting(settings.gateway_error_body_limit_bytes, DEFAULT_ERROR_BODY_LIMIT_BYTES);
  return new Promise((resolve, reject) => {
    let websocket;
    let responseHeaders = {};
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => {
      websocket?.terminate();
      reject(signal.reason || abortError("request_aborted", "WebSocket request aborted."));
    });
    try {
      websocket = new WebSocket(upstreamUrl, protocols, {
        headers,
        handshakeTimeout: timeoutMs,
        maxPayload: positiveSetting(settings.gateway_websocket_max_payload_bytes, DEFAULT_MAX_PAYLOAD_BYTES),
        perMessageDeflate: true
      });
    } catch (error) {
      return finish(() => reject(error));
    }
    websocket.once("upgrade", (response) => {
      responseHeaders = response.headers || {};
    });
    websocket.once("open", () => finish(() => resolve({ websocket, headers: responseHeaders, upstreamUrl })));
    websocket.once("unexpected-response", (_request, response) => {
      collectUnexpectedResponse(response, errorLimit).then(({ body, headers: failureHeaders }) => {
        const error = statusError(response.statusCode || 502, `Upstream WebSocket handshake returned HTTP ${response.statusCode || 502}.`);
        error.headers = failureHeaders;
        error.body = body;
        finish(() => {
          websocket.terminate();
          reject(error);
        });
      }, (error) => finish(() => reject(error)));
    });
    websocket.once("error", (error) => finish(() => reject(error)));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function collectUnexpectedResponse(response, limitBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const done = () => resolve({ body: Buffer.concat(chunks, size), headers: response.headers || {} });
    response.on("data", (chunk) => {
      const remaining = limitBytes - size;
      if (remaining <= 0) return;
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      size += kept.length;
    });
    response.once("end", done);
    response.once("close", done);
    response.once("error", done);
    response.resume();
  });
}

function acceptDownstream(server, request, socket, head, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || abortError("request_aborted", "WebSocket request aborted."));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      server.handleUpgrade(request, socket, head, (websocket) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(websocket);
      });
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    }
  });
}

function waitForWebSocketClose(websocket) {
  if (websocket.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 1006, reason: "" });
  return new Promise((resolve) => websocket.once("close", (code, reason) => resolve({
    code,
    reason: sanitizeCloseReason(reason)
  })));
}

function buildUpstreamWebSocketHeaders(headers, account, path, helpers) {
  const outgoing = helpers.buildUpstreamHeaders(headers, account, false, path);
  for (const key of Object.keys(outgoing)) {
    const lower = key.toLowerCase();
    if (lower === "upgrade" || lower === "connection" || lower.startsWith("sec-websocket-")) {
      delete outgoing[key];
    }
  }
  return outgoing;
}

function responseHeadersForClient(headers, settings, store, helpers) {
  const result = [];
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (BLOCKED_CLIENT_RESPONSE_HEADERS.has(lower) || !SEMANTIC_CLIENT_RESPONSE_HEADERS.has(lower)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) result.push(`${key}: ${item}`);
    }
  }
  if (settings.codex_quota_headers_mode === "rewrite") {
    for (const [key, value] of Object.entries(helpers.buildCodexQuotaHeaders(store.listAccounts()))) {
      result.push(`${key}: ${value}`);
    }
  }
  return result;
}

function parseProtocols(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isWebSocketQuotaFailure(error, helpers) {
  if (Number(error.statusCode) === 429) return true;
  return helpers.isQuotaExhaustedResponse(error.statusCode, error.body);
}

function scheduleUsageRefresh(account, hooks, routing, store) {
  if (!hooks.refreshAllUsage) return;
  Promise.resolve()
    .then(() => hooks.refreshAllUsage("gateway-websocket-quota-without-headers"))
    .then((results) => {
      if (!Array.isArray(results) || results.some((item) => item?.id === account.id && item.ok)) routing.clearCooldown(account.id);
    })
    .catch((error) => store.addAppLog?.({
      level: "warn",
      scope: "gateway-websocket",
      action: "quota-refresh",
      status: "failed",
      message: `WebSocket 配额错误后刷新账号状态失败：${account.email || account.name || account.id}: ${error.message}`
    }));
}

function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: { message } });
  const reason = statusReason(status);
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body
  ].join("\r\n"));
}

function publicUpgradeError(error) {
  if (error.code === "client_cancelled") return "WebSocket client disconnected.";
  if (error.statusCode) return error.message;
  return "The gateway could not establish the upstream WebSocket connection.";
}

function logOpen(store, parsedUrl, account, connectionId, started) {
  store.addAppLog?.({
    level: "info",
    scope: "gateway-websocket",
    action: "connect",
    status: "success",
    message: `[${connectionId}] ${parsedUrl.pathname} 已连接账号 ${account.email || account.name || account.id}，握手耗时 ${Date.now() - started}ms。`
  });
}

function logClose(store, parsedUrl, account, connectionId, detail, started) {
  const reason = detail.reason ? `，原因：${detail.reason}` : "";
  store.addAppLog?.({
    level: "info",
    scope: "gateway-websocket",
    action: "disconnect",
    status: String(detail.code),
    message: `[${connectionId}] ${parsedUrl.pathname} 已断开账号 ${account.email || account.name || account.id}，连接时长 ${Date.now() - started}ms，关闭码 ${detail.code}${reason}。`
  });
}

function sanitizeCloseReason(reason) {
  return Buffer.from(reason || Buffer.alloc(0))
    .toString("utf8")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 256);
}

function pathFromUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(value || "");
  }
}

function logFailure(store, parsedUrl, account, connectionId, error, started) {
  if (error.code === "client_cancelled") return;
  store.addAppLog?.({
    level: "error",
    scope: "gateway-websocket",
    action: "connect",
    status: error.code || String(error.statusCode || "failed"),
    message: `[${connectionId}] ${parsedUrl.pathname} 连接账号 ${account.email || account.name || account.id} 失败（${Date.now() - started}ms）：${error.message}`
  });
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lower) return String(Array.isArray(value) ? value[0] || "" : value || "");
  }
  return "";
}

function positiveSetting(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function abortError(code, message) {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = code;
  return error;
}

function abortController(controller, code, message) {
  if (!controller.signal.aborted) controller.abort(abortError(code, message));
}

function statusReason(status) {
  return ({ 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 409: "Conflict", 426: "Upgrade Required", 429: "Too Many Requests", 502: "Bad Gateway", 503: "Service Unavailable" })[status] || "Error";
}

module.exports = {
  createGatewayWebSocketGateway,
  buildUpstreamWebSocketHeaders,
  responseHeadersForClient,
  WEBSOCKET_ROUTES
};
