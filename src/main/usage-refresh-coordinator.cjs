function createUsageRefreshCoordinator(options) {
  let inFlight = null;

  const refreshAll = (reason = "manual") => {
    if (inFlight) return inFlight;
    inFlight = perform(reason).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const perform = async (reason) => {
    const accounts = options.listAccounts().filter((account) => account.enabled && account.access_token);
    const results = await mapWithConcurrency(accounts, options.concurrency || 3, async (account) => {
      try {
        await options.refreshAccount(account.id);
        return { id: account.id, label: account.email || account.name || account.id, ok: true };
      } catch (error) {
        return { id: account.id, label: account.email || account.name || account.id, ok: false, message: error.message };
      }
    });
    const okCount = results.filter((item) => item.ok).length;
    const failed = results.filter((item) => !item.ok);
    const detail = failed.length > 0
      ? `；失败：${failed.map((item) => `${item.label}: ${options.compactError(item.message)}`).join(" | ")}`
      : "";
    options.addLog({
      scope: "usage",
      action: "refresh-all",
      status: failed.length === 0 && results.length > 0 ? "success" : failed.length < results.length ? "partial" : "failed",
      message: `${reason}: ${okCount}/${results.length} refreshed${detail}`
    });
    if (results.length > 0 && failed.length === 0) {
      options.saveSettings({ last_usage_refresh_all_at: Math.floor(options.now() / 1000) });
    }
    return results;
  };

  return { refreshAll };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

module.exports = { createUsageRefreshCoordinator };
