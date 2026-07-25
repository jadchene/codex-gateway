const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 1000;

/**
 * Observes copies of WebSocket JSON messages without changing relay payloads.
 */
function createWebSocketObserver(options) {
  const { store, account, request, requestPath, upstreamPath, helpers, settings, onIdleTimeout } = options;
  let currentRequest = null;
  let idleTimer = null;

  function onDownstreamMessage(data, isBinary) {
    if (isBinary) return;
    const event = parseJson(data);
    if (event?.type !== "response.create") return;
    currentRequest = {
      startedAt: Date.now(),
      prewarm: event.generate === false,
      usage: emptyUsage()
    };
    armIdleTimer();
  }

  function onUpstreamMessage(data, isBinary) {
    if (currentRequest) armIdleTimer();
    if (isBinary) return;
    const event = parseJson(data);
    if (!event) return;
    observeRateLimits(event);
    observeQuotaError(event, data);
    if (!currentRequest) return;
    const usage = helpers.extractTokenUsage(data);
    if (hasUsage(usage)) currentRequest.usage = usage;
    if (event.type === "response.completed") finishRequest(200, null);
    else if (isTerminalError(event)) finishRequest(errorStatus(event), errorMessage(event));
  }

  function onClose(code, reason) {
    if (!currentRequest) return;
    const message = `WebSocket closed before response completion (${code}${reason?.length ? `: ${reason.toString()}` : ""})`;
    finishRequest(code === 1000 ? 499 : 502, message);
  }

  function finishRequest(status, message) {
    if (!currentRequest) return;
    clearIdleTimer();
    store.addTokenLog?.({
      account_id: account.id,
      method: "WS",
      request_path: requestPath,
      upstream_path: upstreamPath,
      session_id: headerValue(request.headers, "session_id")
        || headerValue(request.headers, "session-id")
        || headerValue(request.headers, "x-session-id"),
      version: headerValue(request.headers, "version"),
      status,
      duration_ms: Date.now() - currentRequest.startedAt,
      ...currentRequest.usage,
      message: currentRequest.prewarm
        ? ["WebSocket prewarm", message].filter(Boolean).join(": ")
        : message
    });
    currentRequest = null;
  }

  function observeRateLimits(event) {
    if (event.type !== "codex.rate_limits") return;
    const usage = {};
    if (settings.ignore_five_hour_limit !== "true") {
      applyRateLimitWindow(usage, event.rate_limits?.primary, "quota_5h_used_percent", "quota_5h_reset_at");
    }
    applyRateLimitWindow(usage, event.rate_limits?.secondary, "quota_7d_used_percent", "quota_7d_reset_at");
    if (Object.keys(usage).length === 0) return;
    usage.raw_usage_json = JSON.stringify({ source: "gateway-websocket-event", at: Math.floor(Date.now() / 1000), event });
    store.updateUsage?.(account.id, usage);
  }

  function observeQuotaError(event, data) {
    if (!isTerminalError(event) || !helpers.isQuotaExhaustedResponse(429, data)) return;
    options.routing.setCooldown(account.id, positiveSetting(settings.gateway_quota_cooldown_ms, DEFAULT_QUOTA_COOLDOWN_MS));
    scheduleUsageRefresh(account, options.hooks, options.routing, store);
  }

  function armIdleTimer() {
    clearIdleTimer();
    const timeoutMs = positiveSetting(settings.gateway_websocket_idle_timeout_ms, DEFAULT_IDLE_TIMEOUT_MS);
    idleTimer = setTimeout(onIdleTimeout, timeoutMs);
  }

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  return {
    onDownstreamMessage,
    onUpstreamMessage,
    onClose,
    dispose: clearIdleTimer
  };
}

function applyRateLimitWindow(target, window, usedField, resetField) {
  if (!window || typeof window !== "object") return;
  const used = Number(window.used_percent);
  const resetAt = Number(window.reset_at);
  if (Number.isFinite(used)) target[usedField] = Math.max(0, Math.min(100, used));
  if (Number.isFinite(resetAt) && resetAt > 0) target[resetField] = Math.trunc(resetAt);
}

function isTerminalError(event) {
  return event?.type === "error" || event?.type === "response.failed";
}

function errorStatus(event) {
  const value = Number(event?.status || event?.status_code || event?.error?.status || event?.error?.status_code);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

function errorMessage(event) {
  const message = event?.error?.message || event?.message || event?.error?.code || event?.code || "WebSocket response failed.";
  return String(message).slice(0, 1000);
}

function parseJson(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch {
    return null;
  }
}

function hasUsage(usage) {
  return usage && Object.values(usage).some((value) => Number(value) > 0);
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

function scheduleUsageRefresh(account, hooks, routing, store) {
  if (!hooks?.refreshAllUsage) return;
  Promise.resolve()
    .then(() => hooks.refreshAllUsage("gateway-websocket-event-quota"))
    .then((results) => {
      if (!Array.isArray(results) || results.some((item) => item?.id === account.id && item.ok)) routing.clearCooldown(account.id);
    })
    .catch((error) => store.addAppLog?.({
      level: "warn",
      scope: "gateway-websocket",
      action: "quota-refresh",
      status: "failed",
      message: `WebSocket 配额事件后刷新账号状态失败：${account.email || account.name || account.id}: ${error.message}`
    }));
}

module.exports = { createWebSocketObserver };
