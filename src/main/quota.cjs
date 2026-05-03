function percentFromLimit(limit) {
  if (!limit || typeof limit !== "object") return null;
  const used = Number(limit.used ?? limit.current ?? limit.consumed);
  const total = Number(limit.limit ?? limit.total ?? limit.quota);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

function timestampFrom(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function normalizeUsagePayload(payload) {
  const root = payload?.usage || payload?.snapshot || payload || {};
  const windows = collectRateLimitWindows(root);
  const fiveHour = windows.find((item) => Number(item.limit_window_seconds) === 18000)
    || root.gpt5 || root.codex || root.five_hour || root["5h"] || root.window_5h || {};
  const sevenDay = windows.find((item) => Number(item.limit_window_seconds) === 604800)
    || root.gpt5_weekly || root.weekly || root.seven_day || root["7d"] || root.window_7d || {};
  return {
    quota_5h_used_percent: readUsedPercent(fiveHour) ?? Number(root.quota_5h_used_percent ?? root.used_percent ?? 0),
    quota_5h_reset_at: timestampFrom(fiveHour.resets_at ?? fiveHour.reset_at ?? root.quota_5h_reset_at),
    quota_7d_used_percent: readUsedPercent(sevenDay) ?? Number(root.quota_7d_used_percent ?? 0),
    quota_7d_reset_at: timestampFrom(sevenDay.resets_at ?? sevenDay.reset_at ?? root.quota_7d_reset_at),
    raw_usage_json: JSON.stringify(payload ?? {})
  };
}

function readUsedPercent(limit) {
  const direct = Number(limit?.used_percent);
  if (Number.isFinite(direct)) return Math.max(0, Math.min(100, direct));
  return percentFromLimit(limit);
}

function collectRateLimitWindows(root) {
  const windows = [];
  addLimitGroup(windows, root.rate_limit);
  addLimitGroup(windows, root.code_review_rate_limit);
  const additional = root.additional_rate_limits;
  if (Array.isArray(additional)) {
    additional.forEach((item) => addLimitGroup(windows, item));
  } else if (additional && typeof additional === "object") {
    Object.values(additional).forEach((item) => addLimitGroup(windows, item));
  }
  return windows;
}

function addLimitGroup(windows, group) {
  if (!group || typeof group !== "object") return;
  if (group.primary_window) windows.push(group.primary_window);
  if (group.secondary_window) windows.push(group.secondary_window);
}

module.exports = {
  normalizeUsagePayload,
  timestampFrom,
  percentFromLimit,
  collectRateLimitWindows
};
