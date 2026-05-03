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

function pickGatewayAccount(accounts, excludeIds = []) {
  const excluded = new Set(excludeIds);
  return accounts
    .filter(usableAccount)
    .filter((account) => !excluded.has(account.id))
    .sort((left, right) => {
      const scoreDiff = usageScore(left) - usageScore(right);
      if (scoreDiff !== 0) return scoreDiff;
      const priorityDiff = Number(left.priority || 100) - Number(right.priority || 100);
      if (priorityDiff !== 0) return priorityDiff;
      return String(left.name || "").localeCompare(String(right.name || ""));
    })[0] || null;
}

module.exports = {
  pickGatewayAccount,
  usageScore,
  quotaWindowExhausted
};
