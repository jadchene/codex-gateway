function usableAccount(account) {
  return account
    && account.enabled
    && account.status !== "disabled"
    && account.access_token
    && !quotaWindowExhausted(account);
}

function quotaWindowExhausted(account) {
  return [account.quota_5h_used_percent, account.quota_7d_used_percent]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .some((value) => value >= 99.9);
}

function usageScore(account) {
  const windows = [account.quota_5h_used_percent, account.quota_7d_used_percent]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (windows.length === 0) return 0;
  return Math.max(...windows);
}

let lastSelectedAccountId = "";

function pickGatewayAccount(accounts, excludeIds = []) {
  const excluded = new Set(excludeIds);
  const candidates = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => usableAccount(account))
    .filter(({ account }) => !excluded.has(account.id));
  const fullFiveHour = candidates.filter(({ account }) => fiveHourUsed(account) <= 0);
  if (fullFiveHour.length > 0) {
    const ordered = sortAccounts(fullFiveHour).map(({ account }) => account);
    const picked = pickNextAccount(ordered);
    if (picked) lastSelectedAccountId = picked.id;
    return picked;
  }

  const healthy = candidates.filter(({ account }) => fiveHourRemaining(account) >= 5);
  const pool = healthy.length > 0 ? healthy : candidates;
  const ordered = sortAccounts(pool).map(({ account }) => account);
  const picked = pickStickyAccount(ordered, healthy.length > 0);
  if (picked) lastSelectedAccountId = picked.id;
  return picked;
}

function sortAccounts(accounts) {
  return accounts
    .sort((left, right) => {
      const fiveHourDiff = fiveHourUsed(left.account) - fiveHourUsed(right.account);
      if (fiveHourDiff !== 0) return fiveHourDiff;
      const scoreDiff = usageScore(left.account) - usageScore(right.account);
      if (scoreDiff !== 0) return scoreDiff;
      const priorityDiff = Number(left.account.priority || 100) - Number(right.account.priority || 100);
      if (priorityDiff !== 0) return priorityDiff;
      return left.index - right.index;
    });
}

function pickNextAccount(accounts) {
  if (accounts.length === 0) return null;
  const lastIndex = accounts.findIndex((account) => account.id === lastSelectedAccountId);
  return accounts[(lastIndex + 1) % accounts.length];
}

function pickStickyAccount(accounts, avoidLowRemaining) {
  if (accounts.length === 0) return null;
  const current = accounts.find((account) => account.id === lastSelectedAccountId);
  if (current && (!avoidLowRemaining || fiveHourRemaining(current) >= 5)) return current;
  return accounts[0];
}

function fiveHourUsed(account) {
  const value = Number(account.quota_5h_used_percent);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function fiveHourRemaining(account) {
  return Math.max(0, 100 - fiveHourUsed(account));
}

function resetSelectionState() {
  lastSelectedAccountId = "";
}

module.exports = {
  pickGatewayAccount,
  usageScore,
  quotaWindowExhausted,
  resetSelectionState
};
