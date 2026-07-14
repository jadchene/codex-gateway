const { pickBalancedGatewayAccount, usableAccount } = require("./selection.cjs");

const DEFAULT_TURN_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
const MAX_BINDINGS_PER_KIND = 500;

function createGatewayRouting(options = {}) {
  const now = options.now || (() => Date.now());
  const turnBindings = bindingMap(options.snapshot?.turns);
  const stateBindings = bindingMap(options.snapshot?.states);
  const sessionBindings = bindingMap(options.snapshot?.sessions);
  const cooldowns = new Map();
  const activeRequests = new Map();

  function context(headers = {}) {
    prune();
    const turnId = turnIdFromHeaders(headers);
    const turnState = headerValue(headers, "x-codex-turn-state");
    const sessionId = sessionIdFromHeaders(headers);
    const turnBinding = (turnId && turnBindings.get(turnId)) || (turnState && stateBindings.get(turnState)) || null;
    const sessionBinding = sessionId && sessionBindings.get(sessionId) || null;
    if (turnBinding) turnBinding.lastSeenAt = now();
    if (sessionBinding) sessionBinding.lastSeenAt = now();
    return {
      turnId,
      turnState,
      sessionId,
      accountId: turnBinding?.accountId || sessionBinding?.accountId || "",
      established: Boolean(turnBinding),
      sessionPreferred: !turnBinding && Boolean(sessionBinding),
      unknownTurnState: Boolean(turnState && !turnBinding)
    };
  }

  function findBoundAccount(routeContext, accounts) {
    if (!routeContext?.accountId) return null;
    return accounts.find((account) => account.id === routeContext.accountId
      && account.enabled
      && account.status !== "disabled"
      && account.access_token) || null;
  }

  function findPreferredAccount(routeContext, accounts) {
    if (!routeContext?.accountId) return null;
    if (Number(cooldowns.get(routeContext.accountId) || 0) > now()) return null;
    return accounts.find((account) => account.id === routeContext.accountId
      && usableAccount(account, Math.floor(now() / 1000))) || null;
  }

  function selectNewAccount(accounts, excludedIds = []) {
    prune();
    return pickBalancedGatewayAccount(accounts, excludedIds, {
      nowMs: now(),
      activeTurns: loadCounts(),
      cooldowns
    });
  }

  function beginRequest(accountId) {
    if (!accountId) return () => {};
    activeRequests.set(accountId, Number(activeRequests.get(accountId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = Number(activeRequests.get(accountId) || 0) - 1;
      if (next > 0) activeRequests.set(accountId, next);
      else activeRequests.delete(accountId);
    };
  }

  function bind(routeContext, account) {
    if (!routeContext || !account?.id) return;
    const binding = { accountId: account.id, lastSeenAt: now() };
    if (routeContext.turnId) turnBindings.set(routeContext.turnId, binding);
    if (routeContext.turnState) stateBindings.set(routeContext.turnState, binding);
    if (routeContext.sessionId) sessionBindings.set(routeContext.sessionId, binding);
    trimBindings(turnBindings);
    trimBindings(stateBindings);
    trimBindings(sessionBindings);
    routeContext.accountId = account.id;
    routeContext.established = true;
  }

  function observeResponse(routeContext, account, headers) {
    bind(routeContext, account);
    const turnState = responseHeader(headers, "x-codex-turn-state");
    if (turnState && account?.id) {
      const binding = { accountId: account.id, lastSeenAt: now() };
      stateBindings.set(turnState, binding);
      trimBindings(stateBindings);
      if (routeContext) routeContext.turnState = turnState;
    }
    options.onChanged?.(snapshot());
  }

  function setCooldown(accountId, durationMs = DEFAULT_COOLDOWN_MS) {
    if (!accountId) return;
    cooldowns.set(accountId, now() + Math.max(1, Number(durationMs) || DEFAULT_COOLDOWN_MS));
  }

  function clearCooldown(accountId) {
    cooldowns.delete(accountId);
  }

  function activeTurnCounts() {
    const counts = new Map();
    for (const binding of turnBindings.values()) {
      counts.set(binding.accountId, Number(counts.get(binding.accountId) || 0) + 1);
    }
    return counts;
  }

  function loadCounts() {
    const counts = new Map();
    for (const binding of sessionBindings.values()) {
      counts.set(binding.accountId, Number(counts.get(binding.accountId) || 0) + 1);
    }
    for (const [accountId, count] of activeRequests) {
      counts.set(accountId, Number(counts.get(accountId) || 0) + count);
    }
    return counts;
  }

  function prune(ttlMs = DEFAULT_TURN_TTL_MS) {
    const cutoff = now() - Math.max(1, Number(ttlMs) || DEFAULT_TURN_TTL_MS);
    for (const [key, binding] of turnBindings) {
      if (binding.lastSeenAt < cutoff) turnBindings.delete(key);
    }
    for (const [key, binding] of stateBindings) {
      if (binding.lastSeenAt < cutoff) stateBindings.delete(key);
    }
    const sessionCutoff = now() - DEFAULT_SESSION_TTL_MS;
    for (const [key, binding] of sessionBindings) {
      if (binding.lastSeenAt < sessionCutoff) sessionBindings.delete(key);
    }
    for (const [accountId, until] of cooldowns) {
      if (until <= now()) cooldowns.delete(accountId);
    }
  }

  function snapshot() {
    prune();
    return {
      turns: bindingEntries(turnBindings),
      states: bindingEntries(stateBindings),
      sessions: bindingEntries(sessionBindings)
    };
  }

  return {
    context,
    findBoundAccount,
    findPreferredAccount,
    selectNewAccount,
    beginRequest,
    bind,
    observeResponse,
    setCooldown,
    clearCooldown,
    activeTurnCounts,
    prune,
    snapshot,
    cooldowns
  };
}

function bindingMap(entries) {
  const map = new Map();
  for (const item of Array.isArray(entries) ? entries.slice(-MAX_BINDINGS_PER_KIND) : []) {
    const key = String(item?.key || "").slice(0, 16 * 1024);
    const accountId = String(item?.accountId || "").slice(0, 512);
    const lastSeenAt = Number(item?.lastSeenAt || 0);
    if (key && accountId && Number.isFinite(lastSeenAt) && lastSeenAt > 0) {
      map.set(key, { accountId, lastSeenAt });
    }
  }
  return map;
}

function bindingEntries(map) {
  return Array.from(map, ([key, binding]) => ({
    key,
    accountId: binding.accountId,
    lastSeenAt: binding.lastSeenAt
  }))
    .sort((left, right) => left.lastSeenAt - right.lastSeenAt)
    .slice(-MAX_BINDINGS_PER_KIND);
}

function trimBindings(map) {
  if (map.size <= MAX_BINDINGS_PER_KIND) return;
  const oldest = Array.from(map.entries())
    .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
    .slice(0, map.size - MAX_BINDINGS_PER_KIND);
  for (const [key] of oldest) map.delete(key);
}

function sessionIdFromHeaders(headers) {
  return (
    headerValue(headers, "session_id")
    || headerValue(headers, "session-id")
    || headerValue(headers, "x-session-id")
  ).slice(0, 512);
}

function turnIdFromHeaders(headers) {
  const raw = headerValue(headers, "x-codex-turn-metadata");
  if (!raw) return "";
  try {
    const value = JSON.parse(raw);
    const turnId = String(value?.turn_id || "").trim();
    return turnId.slice(0, 512);
  } catch {
    return "";
  }
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== lower) continue;
    const text = Array.isArray(value) ? value[0] : value;
    return String(text || "").slice(0, 16 * 1024);
  }
  return "";
}

function responseHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "").slice(0, 16 * 1024);
  return headerValue(headers, name);
}

module.exports = {
  createGatewayRouting,
  turnIdFromHeaders,
  sessionIdFromHeaders
};
