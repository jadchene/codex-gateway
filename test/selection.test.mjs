import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickGatewayAccount, quotaWindowExhausted, usageScore } = require("../src/main/selection.cjs");
const { buildUpstreamUrl, isQuotaExhaustedResponse } = require("../src/main/gateway.cjs");

test("pickGatewayAccount chooses enabled token account with lowest quota usage", () => {
  const account = pickGatewayAccount([
    { id: "disabled", enabled: false, access_token: "a", status: "active", quota_5h_used_percent: 0 },
    { id: "busy", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 80 },
    { id: "best", enabled: true, access_token: "c", status: "active", quota_5h_used_percent: 20, priority: 50 }
  ]);
  assert.equal(account.id, "best");
});

test("pickGatewayAccount can exclude failed accounts", () => {
  const account = pickGatewayAccount([
    { id: "first", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 1 },
    { id: "second", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 20 }
  ], ["first"]);
  assert.equal(account.id, "second");
});

test("usageScore uses the highest active quota window", () => {
  assert.equal(usageScore({ quota_5h_used_percent: 12, quota_7d_used_percent: 34 }), 34);
});

test("quotaWindowExhausted marks accounts with a depleted window unavailable", () => {
  assert.equal(quotaWindowExhausted({ quota_5h_used_percent: 100, quota_7d_used_percent: 20 }), true);
  assert.equal(pickGatewayAccount([
    { id: "empty", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 100 },
    { id: "usable", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 50 }
  ]).id, "usable");
});

test("buildUpstreamUrl maps local /v1 requests to codex backend prefix", () => {
  assert.equal(
    buildUpstreamUrl("https://chatgpt.com/backend-api/codex", "/v1/responses?stream=true"),
    "https://chatgpt.com/backend-api/codex/responses?stream=true"
  );
  assert.equal(
    buildUpstreamUrl("https://api.openai.com/v1", "/v1/responses"),
    "https://api.openai.com/v1/responses"
  );
});

test("isQuotaExhaustedResponse detects quota and rate limit failures", () => {
  assert.equal(isQuotaExhaustedResponse(429, Buffer.from('{"error":"rate_limit_exceeded"}')), true);
  assert.equal(isQuotaExhaustedResponse(403, Buffer.from('{"detail":"quota exceeded"}')), true);
  assert.equal(isQuotaExhaustedResponse(500, Buffer.from("rate_limit_exceeded")), false);
});
