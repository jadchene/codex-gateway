import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeUsagePayload, percentFromLimit, timestampFrom } = require("../src/main/quota.cjs");

test("percentFromLimit handles common limit shapes", () => {
  assert.equal(percentFromLimit({ used: 25, limit: 100 }), 25);
  assert.equal(percentFromLimit({ current: 3, total: 4 }), 75);
});

test("timestampFrom accepts seconds, milliseconds, and ISO strings", () => {
  assert.equal(timestampFrom(1_700_000_000), 1_700_000_000);
  assert.equal(timestampFrom(1_700_000_000_000), 1_700_000_000);
  assert.equal(timestampFrom("2026-05-03T00:00:00.000Z"), 1_777_766_400);
});

test("normalizeUsagePayload extracts 5h and 7d quota windows", () => {
  const usage = normalizeUsagePayload({
    usage: {
      "5h": { used: 1, limit: 4, reset_at: 100 },
      "7d": { used: 2, limit: 4, reset_at: 200 }
    }
  });
  assert.equal(usage.quota_5h_used_percent, 25);
  assert.equal(usage.quota_7d_used_percent, 50);
  assert.equal(usage.quota_5h_reset_at, 100);
  assert.equal(usage.quota_7d_reset_at, 200);
});

test("normalizeUsagePayload does not exhaust 7d quota for rate_limit limit_reached", () => {
  const usage = normalizeUsagePayload({
    usage: {
      rate_limit: {
        limit_reached: true,
        primary_window: { limit_window_seconds: 18000, used: 4, limit: 4, reset_at: 100 },
        secondary_window: { limit_window_seconds: 604800, used: 1, limit: 4, reset_at: 200 }
      }
    }
  });
  assert.equal(usage.quota_5h_used_percent, 100);
  assert.equal(usage.quota_7d_used_percent, 25);
});

test("normalizeUsagePayload rounds both quota windows at 99 percent", () => {
  const usage = normalizeUsagePayload({
    usage: {
      "5h": { used_percent: 99 },
      "7d": { used_percent: 99.5 }
    }
  });
  assert.equal(usage.quota_5h_used_percent, 100);
  assert.equal(usage.quota_7d_used_percent, 100);
});
