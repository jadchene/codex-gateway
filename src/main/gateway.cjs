const http = require("node:http");
const { pickGatewayAccount } = require("./selection.cjs");
const { createGatewayRouting } = require("./gateway-routing.cjs");
const { createGatewayWebSocketGateway } = require("./gateway-websocket.cjs");
const {
  writeResponseChunk,
  readBody,
  readResponseBody,
  createRequestLifecycle,
  createLinkedAbortController,
  scheduleAbort,
  abortController,
  cancellationKind,
  cancellationMessage
} = require("./gateway-lifecycle.cjs");

const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_ERROR_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_UNARY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2 * 1000;
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 1000;

function createGateway(store, authService, hooks = {}) {
  let server = null;
  let state = { running: false, url: "", error: "" };
  const activeRequests = new Set();
  const sockets = new Set();
  const routing = createGatewayRouting({
    snapshot: parseAffinitySnapshot(store.getSettings().gateway_affinity_state_json),
    onChanged(snapshot) {
      store.saveSettings({ gateway_affinity_state_json: JSON.stringify(snapshot) });
    }
  });
  let websocketGateway = null;

  async function start() {
    if (server) return state;
    const settings = store.getSettings();
    const host = settings.gateway_host || "127.0.0.1";
    const port = Number(settings.gateway_port || 1455);
    const runtime = { activeRequests, routing };
    server = http.createServer((req, res) => handleRequest(req, res, store, authService, hooks, runtime));
    websocketGateway = createGatewayWebSocketGateway({
      store,
      hooks,
      runtime,
      helpers: {
        buildUpstreamUrl,
        buildUpstreamHeaders,
        buildCodexQuotaHeaders,
        buildCodexQuotaSnapshot,
        syncAccountUsageFromHeaders,
        isQuotaExhaustedResponse,
        isAuthExpiredResponse,
        extractTokenUsage
      }
    });
    server.on("upgrade", websocketGateway.handleUpgrade);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
    });
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server?.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server?.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    } catch (error) {
      const failedServer = server;
      server = null;
      const failedWebsocketGateway = websocketGateway;
      websocketGateway = null;
      failedServer?.removeAllListeners();
      await failedWebsocketGateway?.close();
      state = { running: false, url: "", error: String(error?.message || error) };
      throw error;
    }
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : port;
    state = { running: true, url: `http://${host}:${listeningPort}`, error: "" };
    if (!isLoopbackHost(host) && (!settings.gateway_api_key || settings.gateway_api_key === "local-personal-token")) {
      store.addAppLog?.({
        level: "warn",
        scope: "gateway",
        action: "start",
        status: "insecure-listener",
        message: "网关正在非回环地址上监听，但 API Key 为空或仍为默认值；请立即生成随机 Key，避免账号代理能力被局域网访问。"
      });
    }
    return state;
  }

  async function stop() {
    if (!server) {
      state = { running: false, url: "", error: "" };
      return state;
    }
    const closing = server;
    server = null;
    const closingWebsocketGateway = websocketGateway;
    websocketGateway = null;
    const settings = store.getSettings();
    const graceMs = positiveSetting(settings.gateway_shutdown_grace_ms, DEFAULT_SHUTDOWN_GRACE_MS);
    const closePromise = new Promise((resolve) => closing.close(resolve));
    for (const controller of activeRequests) abortController(controller, "gateway_shutdown", "Gateway is shutting down.");
    let forcedSocketCount = 0;
    let forceTimer = null;
    const forcePromise = new Promise((resolve) => {
      forceTimer = setTimeout(() => {
        forcedSocketCount = sockets.size;
        if (typeof closing.closeAllConnections === "function") closing.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        resolve();
      }, graceMs);
    });
    await Promise.race([closePromise, forcePromise]);
    await closingWebsocketGateway?.close();
    if (forceTimer) clearTimeout(forceTimer);
    if (forcedSocketCount > 0 && store.addAppLog) {
      store.addAppLog({
        level: "warn",
        scope: "gateway",
        action: "stop",
        status: "forced",
        message: `网关停机宽限期结束，强制关闭 ${forcedSocketCount} 个残留连接。`
      });
    }
    state = { running: false, url: "", error: "" };
    return state;
  }

  function status() {
    return state;
  }

  return { start, stop, status };
}

async function handleRequest(req, res, store, authService, hooks, runtime = {}) {
  const started = Date.now();
  const settings = store.getSettings();
  const parsedUrl = new URL(req.url, "http://localhost");
  const pathname = parsedUrl.pathname;
  if (req.method === "GET" && pathname === "/auth/callback") {
    return handleAuthCallback(parsedUrl, res, authService);
  }
  const route = matchGatewayRoute(req.method, pathname);
  if (!route.pathAllowed) {
    return sendJson(res, 404, { error: { message: "Unrecognized request URL." } });
  }
  if (!route.methodAllowed) {
    res.setHeader("allow", route.allowedMethods.join(", "));
    return sendJson(res, 405, { error: { message: "Method not allowed." } });
  }
  const auth = req.headers.authorization || "";
  const localKey = settings.gateway_api_key || "";
  if (localKey && auth !== `Bearer ${localKey}`) {
    return sendJson(res, 401, { error: { message: "Incorrect API key provided." } });
  }
  const maxConcurrentRequests = positiveSetting(settings.gateway_max_concurrent_requests, 16);
  if (runtime.activeRequests?.size >= maxConcurrentRequests) {
    return sendJson(res, 503, { error: { message: "The gateway has reached its concurrent request limit." } });
  }

  const lifecycle = createRequestLifecycle(req, res, runtime.activeRequests);
  const totalTimeoutMs = isStreamingResponsesPath(pathname)
    ? 0
    : positiveSetting(settings.gateway_unary_timeout_ms, legacyUnaryTimeout(settings));
  const stopTotalTimeout = scheduleAbort(lifecycle.controller, totalTimeoutMs, "unary_timeout", "Upstream request timed out.");
  let request = null;
  let accountForLog = null;
  let releaseAccountLoad = () => {};
  let disposeUpstream = () => {};
  try {
    const bodyLimit = positiveSetting(settings.gateway_request_body_limit_bytes, DEFAULT_REQUEST_BODY_LIMIT_BYTES);
    const incomingBody = await readBody(req, bodyLimit, lifecycle.signal);
    request = buildGatewayRequest(settings.upstream_base_url, req.url, incomingBody, req.headers);
    const accounts = store.listAccounts();
    const routeContext = runtime.routing?.context(req.headers) || { established: false, accountId: "" };
    if (routeContext.unknownTurnState) {
      return sendJson(res, 409, {
        error: { message: "The gateway cannot safely route this existing turn state. Start a new Codex turn and try again." }
      });
    }
    let firstAccount = null;
    if (routeContext.established) {
      firstAccount = runtime.routing.findBoundAccount(routeContext, accounts);
    } else {
      firstAccount = runtime.routing?.findPreferredAccount(routeContext, accounts) || null;
      if (!firstAccount) {
        firstAccount = runtime.routing
          ? runtime.routing.selectNewAccount(accounts)
          : selectInitialGatewayAccount(store, settings);
      }
    }
    if (!firstAccount) {
      const message = routeContext.established
        ? "The account assigned to this Codex turn is unavailable. Start a new turn and try again."
        : "The server is currently unavailable. Please try again later.";
      return sendJson(res, 503, { error: { message } });
    }
    accountForLog = firstAccount;
    releaseAccountLoad = runtime.routing?.beginRequest(firstAccount.id) || (() => {});

    const result = await callWithFailover(req, request, firstAccount, settings, store, hooks, {
      signal: lifecycle.signal,
      allowAccountFailover: !routeContext.established,
      routing: runtime.routing,
      onAccountSelected(account) {
        if (!account?.id || account.id === accountForLog?.id) return;
        releaseAccountLoad();
        releaseAccountLoad = runtime.routing?.beginRequest(account.id) || (() => {});
        accountForLog = account;
      }
    });
    disposeUpstream = result.dispose || (() => {});
    const { account, response, body, tokenUsage: errorUsage } = result;
    accountForLog = account;

    if (response.status >= 200 && response.status < 300) {
      runtime.routing?.observeResponse(routeContext, account, response.headers);
      res.statusCode = response.status;
      copyHeadersToResponse(response.headers, res, settings, store);

      const usageParser = createSseUsageParser();
      if (response.body) {
        const reader = response.body.getReader();
        const idleTimeoutMs = isStreamingResponsesPath(pathname)
          ? positiveSetting(settings.gateway_stream_idle_timeout_ms, DEFAULT_STREAM_IDLE_TIMEOUT_MS)
          : 0;
        let stopIdleTimeout = scheduleAbort(lifecycle.controller, idleTimeoutMs, "stream_idle_timeout", "Upstream response stream became idle.");
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            stopIdleTimeout();
            stopIdleTimeout = scheduleAbort(lifecycle.controller, idleTimeoutMs, "stream_idle_timeout", "Upstream response stream became idle.");
            usageParser.feed(value);
            await writeResponseChunk(res, value, lifecycle.signal);
          }
        } finally {
          stopIdleTimeout();
          if (!res.writableEnded && !res.destroyed) res.end();
        }
      } else {
        res.end();
      }

      store.addTokenLog({
        account_id: account.id,
        method: req.method,
        request_path: request.originalPath,
        upstream_path: pathFromUrl(request.upstreamUrl),
        session_id: sessionHeaderValue(req.headers),
        version: headerValue(req.headers.version),
        status: response.status,
        duration_ms: Date.now() - started,
        ...usageParser.latestUsage(),
        message: null
      });
    } else {
      res.statusCode = response.status;
      copyHeadersToResponse(response.headers, res, settings, store);
      res.end(body);
      store.addTokenLog({
        account_id: account.id,
        method: req.method,
        request_path: request.originalPath,
        upstream_path: pathFromUrl(request.upstreamUrl),
        session_id: sessionHeaderValue(req.headers),
        version: headerValue(req.headers.version),
        status: response.status,
        duration_ms: Date.now() - started,
        ...errorUsage,
        message: null
      });
    }
  } catch (error) {
    const cancellation = cancellationKind(error, lifecycle.signal);
    const status = Number(error?.statusCode || (cancellation === "client_cancelled" ? 499 : 502));
    const message = cancellationMessage(cancellation, error);
    const requestPath = request?.originalPath || `${pathname}${parsedUrl.search}`;
    const upstreamPath = request?.upstreamUrl ? pathFromUrl(request.upstreamUrl) : pathFromUrl(buildUpstreamUrl(settings.upstream_base_url, req.url));
    if (request && accountForLog) {
      store.addTokenLog({
        account_id: accountForLog.id,
        method: req.method,
        request_path: request.originalPath,
        upstream_path: pathFromUrl(request.upstreamUrl),
        session_id: sessionHeaderValue(req.headers),
        version: headerValue(req.headers.version),
        status,
        duration_ms: Date.now() - started,
        ...emptyUsage(),
        message: gatewayErrorMessage(error, message)
      });
    }
    store.addAppLog({
      level: cancellation === "client_cancelled" ? "info" : "error",
      scope: "gateway",
      action: "request",
      status: cancellation || "failed",
      message: `${req.method || "-"} ${requestPath} -> ${upstreamPath}: ${gatewayErrorMessage(error, message)}`
    });
    if (!res.headersSent && !res.destroyed) {
      const clientMessage = error?.statusCode === 413
        ? error.message
        : cancellation && cancellation !== "client_cancelled"
          ? "Request timed out."
          : "The server encountered a temporary error and could not complete your request.";
      sendJson(res, status, { error: { message: clientMessage } });
    } else if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  } finally {
    stopTotalTimeout();
    disposeUpstream();
    releaseAccountLoad();
    lifecycle.dispose();
  }
}

const GATEWAY_ROUTES = {
  "/v1/models": ["GET"],
  "/v1/responses": ["POST"],
  "/v1/responses/compact": ["POST"],
  "/v1/memories/trace_summarize": ["POST"],
  "/v1/images/generations": ["POST"],
  "/v1/images/edits": ["POST"],
  "/v1/realtime/calls": ["POST"]
};

function selectInitialGatewayAccount(store, settings, now = new Date()) {
  const options = dailyRebalanceOptions(settings, now);
  const account = pickGatewayAccount(store.listAccounts(), settings.gateway_current_account_id || "", [], options);
  if (!account) return null;
  const patch = { gateway_current_account_id: account.id };
  if (options.dailyRebalanceDate) patch.gateway_last_daily_rebalance_date = options.dailyRebalanceDate;
  store.saveSettings(patch);
  if (options.dailyRebalanceDate && store.addAppLog) {
    store.addAppLog({
      scope: "gateway",
      action: "daily-rebalance",
      status: "success",
      message: `当天首次网关请求按 7 天剩余额度选择账号：${account.email || account.name || account.id}`
    });
  }
  return account;
}

function dailyRebalanceOptions(settings, now = new Date()) {
  const today = dailyRebalanceDateKey(now);
  if (!today || settings.gateway_last_daily_rebalance_date === today) return {};
  return { preferSevenDayQuota: true, dailyRebalanceDate: today };
}

function dailyRebalanceDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  if (!Number.isFinite(year)) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function matchGatewayRoute(method, pathname) {
  const allowedMethods = GATEWAY_ROUTES[pathname] || [];
  const normalizedMethod = String(method || "").toUpperCase();
  return {
    pathAllowed: allowedMethods.length > 0,
    methodAllowed: allowedMethods.includes(normalizedMethod),
    allowedMethods
  };
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value ? String(value) : "";
}

function sessionHeaderValue(headers) {
  return headerValue(headers?.session_id)
    || headerValue(headers?.["session-id"])
    || headerValue(headers?.["x-session-id"]);
}

async function callWithFailover(req, request, firstAccount, settings, store, hooks, options = {}) {
  const excluded = new Set();
  let account = firstAccount;
  let lastResult = null;
  let lastAccount = null;
  const allowAccountFailover = options.allowAccountFailover !== false;
  const maxAttempts = allowAccountFailover ? Math.max(1, store.listAccounts().length) : 1;
  for (let attempt = 0; attempt < maxAttempts && account; attempt += 1) {
    lastAccount = account;
    options.onAccountSelected?.(account);
    let result = await callUpstream(req, request, account, settings, options.signal);
    if (isAuthExpiredResponse(result.response.status, result.body) && hooks.refreshAccountToken) {
      try {
        const refreshed = await hooks.refreshAccountToken(account.id);
        account = refreshed || account;
        options.onAccountSelected?.(account);
        result = await callUpstream(req, request, account, settings, options.signal);
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
    const syncedUsage = syncAccountUsageFromHeaders(account, result.response.headers, store);
    if (!isQuotaExhaustedResponse(result.response.status, result.body)) {
      saveCurrentGatewayAccount(store, account);
      return { account, ...result };
    }
    lastResult = result;
    if (!syncedUsage) {
      const cooldownMs = positiveSetting(settings.gateway_quota_cooldown_ms, DEFAULT_QUOTA_COOLDOWN_MS);
      options.routing?.setCooldown(account.id, cooldownMs);
      scheduleUsageRefresh(account, hooks, options.routing, store);
    }
    if (!allowAccountFailover) return { account, ...result };
    excluded.add(account.id);
    account = options.routing
      ? options.routing.selectNewAccount(store.listAccounts(), Array.from(excluded))
      : pickGatewayAccount(store.listAccounts(), "", Array.from(excluded));
  }
  if (lastResult) return { account: lastAccount || firstAccount, ...lastResult };
  throw new Error("No enabled GPT account with an access token is available.");
}

function saveCurrentGatewayAccount(store, account) {
  if (account?.id) store.saveSettings({ gateway_current_account_id: account.id });
}

function scheduleUsageRefresh(account, hooks, routing, store) {
  if (!hooks.refreshAllUsage) return;
  Promise.resolve()
    .then(() => hooks.refreshAllUsage("gateway-quota-without-headers"))
    .then((results) => {
      if (!Array.isArray(results) || results.some((item) => item?.id === account.id && item.ok)) {
        routing?.clearCooldown(account.id);
      }
    })
    .catch((error) => {
      store.addAppLog?.({
        level: "warn",
        scope: "gateway",
        action: "quota-refresh",
        status: "failed",
        message: `配额错误后刷新账号状态失败：${account.email || account.name || account.id}: ${error.message}`
      });
    });
}

async function callUpstream(req, request, account, settings, parentSignal) {
  const timeoutMs = positiveSetting(settings.gateway_connect_timeout_ms, DEFAULT_CONNECT_TIMEOUT_MS);
  const attempt = createLinkedAbortController(parentSignal);
  const stopTimeout = scheduleAbort(attempt.controller, timeoutMs, "connect_timeout", "Upstream connection timed out.");
  const hasBody = request.body.length > 0 && req.method !== "GET" && req.method !== "HEAD";
  let handedOff = false;
  try {
    const upstream = await fetch(request.upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, account, hasBody, request.path),
      body: hasBody ? request.body : undefined,
      signal: attempt.signal
    });
    stopTimeout();
    if (upstream.status >= 200 && upstream.status < 300) {
      handedOff = true;
      return { response: upstream, body: null, tokenUsage: emptyUsage(), dispose: attempt.dispose };
    }
    const errorLimit = positiveSetting(settings.gateway_error_body_limit_bytes, DEFAULT_ERROR_BODY_LIMIT_BYTES);
    const responseBody = await readResponseBody(upstream, errorLimit, attempt.signal);
    return { response: upstream, body: responseBody, tokenUsage: extractTokenUsage(responseBody) };
  } finally {
    stopTimeout();
    if (!handedOff) attempt.dispose();
  }
}

function syncAccountUsageFromHeaders(account, headers, store) {
  if (!account?.id || !headers || !store?.updateUsage) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const usage = {};
  const primaryUsed = numberHeader(headers, "x-codex-primary-used-percent");
  const primaryResetAfter = numberHeader(headers, "x-codex-primary-reset-after-seconds");
  const secondaryUsed = numberHeader(headers, "x-codex-secondary-used-percent");
  const secondaryResetAfter = numberHeader(headers, "x-codex-secondary-reset-after-seconds");

  applyQuotaHeaderWindow(usage, account, {
    used: primaryUsed,
    resetAfter: primaryResetAfter,
    usedField: "quota_5h_used_percent",
    resetField: "quota_5h_reset_at",
    nowSeconds
  });
  applyQuotaHeaderWindow(usage, account, {
    used: secondaryUsed,
    resetAfter: secondaryResetAfter,
    usedField: "quota_7d_used_percent",
    resetField: "quota_7d_reset_at",
    nowSeconds
  });
  if (Object.keys(usage).length > 0) {
    usage.raw_usage_json = JSON.stringify({
      source: "gateway-response-headers",
      at: nowSeconds,
      headers: {
        "x-codex-primary-used-percent": headerGet(headers, "x-codex-primary-used-percent"),
        "x-codex-primary-reset-after-seconds": headerGet(headers, "x-codex-primary-reset-after-seconds"),
        "x-codex-secondary-used-percent": headerGet(headers, "x-codex-secondary-used-percent"),
        "x-codex-secondary-reset-after-seconds": headerGet(headers, "x-codex-secondary-reset-after-seconds")
      }
    });
    store.updateUsage(account.id, usage);
    return true;
  }
  return false;
}

function applyQuotaHeaderWindow(usage, account, options) {
  const { used, resetAfter, usedField, resetField, nowSeconds } = options;
  const hasUsed = Number.isFinite(used);
  const hasReset = Number.isFinite(resetAfter);
  const resetSeconds = hasReset ? Math.max(0, Math.trunc(resetAfter)) : null;
  const existingUsed = Number(account?.[usedField]);
  const existingResetAt = Number(account?.[resetField]);
  const hasExistingPositiveUsage = Number.isFinite(existingUsed) && existingUsed > 0;
  const hasExistingFutureReset = Number.isFinite(existingResetAt) && existingResetAt > nowSeconds;
  const isAmbiguousZero = hasUsed
    && clampPercent(used) === 0
    && (!hasReset || resetSeconds === 0)
    && (hasExistingPositiveUsage || hasExistingFutureReset);

  if (hasUsed && !isAmbiguousZero) usage[usedField] = clampPercent(used);
  if (hasReset && resetSeconds > 0) usage[resetField] = nowSeconds + resetSeconds;
}

function numberHeader(headers, name) {
  const raw = headerGet(headers, name);
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function headerGet(headers, name) {
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

const BLOCKED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "set-cookie",
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

function copyHeadersToResponse(headers, res, settings = {}, store = null) {
  const connectionHeaders = connectionHeaderTokens(headers);
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!BLOCKED_RESPONSE_HEADERS.has(lower) && !connectionHeaders.has(lower)) {
      res.setHeader(key, value);
    }
  });
  if (settings.codex_quota_headers_mode === "rewrite") {
    const accounts = store?.listAccounts ? store.listAccounts() : [];
    const detail = buildCodexQuotaHeaderDetail(accounts);
    setCodexQuotaHeaders(res, detail.headers);
  }
}

function setCodexQuotaHeaders(res, headers) {
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

function buildCodexQuotaHeaders(accounts, nowSeconds = Math.floor(Date.now() / 1000)) {
  return buildCodexQuotaHeaderDetail(accounts, nowSeconds).headers;
}

function buildCodexQuotaHeaderDetail(accounts, nowSeconds = Math.floor(Date.now() / 1000)) {
  const detail = buildCodexQuotaSnapshotDetail(accounts, nowSeconds);
  const { snapshot, primary, secondary } = detail;
  const headers = {
    "x-codex-primary-used-percent": formatHeaderNumber(snapshot.primary.used_percent),
    "x-codex-primary-window-minutes": String(snapshot.primary.window_minutes),
    "x-codex-primary-reset-after-seconds": String(snapshot.primary.reset_after_seconds),
    "x-codex-secondary-used-percent": formatHeaderNumber(snapshot.secondary.used_percent),
    "x-codex-secondary-window-minutes": String(snapshot.secondary.window_minutes),
    "x-codex-secondary-reset-after-seconds": String(snapshot.secondary.reset_after_seconds),
    "x-codex-plan-type": snapshot.plan_type,
    "x-codex-active-limit": snapshot.active_limit,
    "x-codex-credits-balance": String(snapshot.credits.balance),
    "x-codex-credits-has-credits": String(snapshot.credits.has_credits),
    "x-codex-credits-unlimited": String(snapshot.credits.unlimited)
  };
  return {
    headers,
    nowSeconds,
    accountCount: detail.accountCount,
    primary,
    secondary
  };
}

function buildCodexQuotaSnapshot(accounts, nowSeconds = Math.floor(Date.now() / 1000)) {
  return buildCodexQuotaSnapshotDetail(accounts, nowSeconds).snapshot;
}

function buildCodexQuotaSnapshotDetail(accounts, nowSeconds) {
  const pool = accounts.filter((account) => account
    && account.enabled
    && account.status !== "disabled"
    && account.access_token);
  const primary = resetAfterSeconds(pool, "quota_5h_reset_at", nowSeconds);
  const secondary = resetAfterSeconds(pool, "quota_7d_reset_at", nowSeconds);
  const snapshot = {
    primary: {
      used_percent: roundHeaderPercent(remainingPercent(pool, "quota_5h_used_percent")),
      window_minutes: 300,
      reset_after_seconds: primary.value,
      reset_at: primary.selected?.reset_at || 0
    },
    secondary: {
      used_percent: roundHeaderPercent(remainingPercent(pool, "quota_7d_used_percent")),
      window_minutes: 10080,
      reset_after_seconds: secondary.value,
      reset_at: secondary.selected?.reset_at || 0
    },
    plan_type: "unknown",
    active_limit: "primary",
    credits: {
      balance: 0,
      has_credits: false,
      unlimited: false
    }
  };
  return {
    snapshot,
    accountCount: pool.length,
    primary,
    secondary
  };
}

function remainingPercent(accounts, field) {
  const remaining = accounts
    .map((account) => Number(account[field]))
    .filter((value) => Number.isFinite(value))
    .reduce((sum, value) => sum + Math.max(0, 100 - clampPercent(value)), 0);
  return 100 - Math.min(100, remaining);
}

function resetAfterSeconds(accounts, field, nowSeconds) {
  let nearest = null;
  const candidates = [];
  for (const account of accounts) {
    const resetAt = Number(account[field]);
    if (!Number.isFinite(resetAt) || resetAt <= 0) continue;
    const item = {
      id: account.id,
      email: account.email || account.name || account.id,
      reset_at: resetAt,
      reset_after_seconds: Math.max(0, Math.trunc(resetAt - nowSeconds))
    };
    candidates.push(item);
    if (nearest === null || resetAt < nearest.reset_at) nearest = item;
  }
  return {
    value: nearest === null ? 0 : nearest.reset_after_seconds,
    selected: nearest,
    candidates
  };
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function formatHeaderNumber(value) {
  const rounded = roundHeaderPercent(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function roundHeaderPercent(value) {
  return Math.round(clampPercent(value) * 10) / 10;
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

function extractTokenUsage(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  if (!text.trim()) return emptyUsage();
  const direct = parseUsageJson(text);
  if (hasUsage(direct)) return direct;
  return parseUsageSse(text);
}

function createSseUsageParser() {
  const decoder = new TextDecoder();
  let tail = "";
  let latest = emptyUsage();

  function consume(text, flush = false) {
    const lines = text.split(/\r?\n/);
    tail = flush ? "" : lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      if (!payload || payload === "[DONE]") continue;
      let usage = parseUsageJson(payload);
      if (!hasUsage(usage)) usage = parseUsageFromJsonTail(payload);
      if (hasUsage(usage)) latest = usage;
    }
    if (tail.length > DEFAULT_ERROR_BODY_LIMIT_BYTES) tail = tail.slice(-DEFAULT_ERROR_BODY_LIMIT_BYTES);
  }

  return {
    feed(chunk) {
      consume(tail + decoder.decode(chunk, { stream: true }));
    },
    latestUsage() {
      consume(tail + decoder.decode() + "\n", true);
      return latest;
    }
  };
}

function parseUsageFromJsonTail(text) {
  const marker = String(text || "").lastIndexOf('"usage"');
  if (marker < 0) return emptyUsage();
  const start = String(text).indexOf("{", marker + 7);
  if (start < 0) return emptyUsage();
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth !== 0) continue;
    try {
      return usageFromObject({ usage: JSON.parse(text.slice(start, index + 1)) });
    } catch {
      return emptyUsage();
    }
  }
  return emptyUsage();
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

function gatewayErrorMessage(error, fallback) {
  const message = fallback || String(error?.message || error || "");
  const cause = error?.cause;
  const causeParts = [
    cause?.code,
    cause?.errno,
    cause?.syscall,
    cause?.address,
    cause?.port
  ].filter(Boolean);
  return causeParts.length > 0 ? `${message} (${causeParts.join(" ")})` : message;
}

function buildUpstreamHeaders(headers, account, hasBody = false, path = "") {
  const outgoing = {};
  const connectionHeaders = connectionHeaderTokens(headers);
  const discardedHeaders = new Set([
    "host",
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "upgrade",
    "content-length",
    "authorization",
    "cookie",
    "proxy-authorization",
    "openai-organization",
    "openai-project",
    "origin",
    "referer",
    "accept-encoding"
  ]);
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (discardedHeaders.has(lower) || connectionHeaders.has(lower)) continue;
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

function positiveSetting(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function connectionHeaderTokens(headers) {
  const value = typeof headers?.get === "function"
    ? headers.get("connection")
    : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === "connection")?.[1];
  return new Set(String(Array.isArray(value) ? value.join(",") : value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

function parseAffinitySnapshot(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function legacyUnaryTimeout(settings) {
  return positiveSetting(settings.request_timeout_ms, DEFAULT_UNARY_TIMEOUT_MS);
}

function isStreamingResponsesPath(pathname) {
  return pathname === "/v1/responses";
}

function isLoopbackHost(host) {
  const value = String(host || "").trim().toLowerCase();
  return value === "localhost"
    || value === "127.0.0.1"
    || value === "::1"
    || value === "[::1]";
}

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  res.statusCode = status;
  if (!res.headersSent) res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, title, message) {
  if (res.writableEnded) return;
  res.statusCode = status;
  if (!res.headersSent) res.setHeader("content-type", "text/html; charset=utf-8");
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
  matchGatewayRoute,
  buildCodexQuotaHeaders,
  buildCodexQuotaHeaderDetail,
  buildCodexQuotaSnapshot,
  callWithFailover,
  selectInitialGatewayAccount,
  dailyRebalanceDateKey,
  syncAccountUsageFromHeaders,
  extractTokenUsage,
  createSseUsageParser,
  isQuotaExhaustedResponse,
  isAuthExpiredResponse
};
