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

function pickGatewayAccount(accounts, currentAccountId = "", excludeIds = [], options = {}) {
  const excluded = new Set(excludeIds);
  const candidates = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => usableAccount(account))
    .filter(({ account }) => !excluded.has(account.id));
  if (candidates.length === 0) return null;

  if (options.preferSevenDayQuota) {
    const picked = sortAccountsBySevenDayQuota(candidates).at(0)?.account || null;
    if (picked) lastSelectedAccountId = picked.id;
    return picked;
  }

  const current = candidates.find(({ account }) => account.id === currentAccountId)?.account;
  if (current) {
    lastSelectedAccountId = current.id;
    return current;
  }

  const ordered = sortAccounts(candidates).map(({ account }) => account);
  const picked = pickNextAccount(ordered);
  if (picked) lastSelectedAccountId = picked.id;
  return picked;
}

function sortAccounts(accounts) {
  return accounts
    .sort((left, right) => {
      const priorityDiff = Number(left.account.priority || 100) - Number(right.account.priority || 100);
      if (priorityDiff !== 0) return priorityDiff;
      return left.index - right.index;
    });
}

function sortAccountsBySevenDayQuota(accounts) {
  return accounts
    .sort((left, right) => {
      const weeklyDiff = usedPercent(left.account.quota_7d_used_percent) - usedPercent(right.account.quota_7d_used_percent);
      if (weeklyDiff !== 0) return weeklyDiff;
      const fiveHourDiff = usedPercent(left.account.quota_5h_used_percent) - usedPercent(right.account.quota_5h_used_percent);
      if (fiveHourDiff !== 0) return fiveHourDiff;
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

function usedPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
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
