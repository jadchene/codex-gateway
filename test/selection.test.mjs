import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickGatewayAccount, quotaWindowExhausted, resetSelectionState, usageScore } = require("../src/main/selection.cjs");
const { buildAuthorizeUrl } = require("../src/main/auth.cjs");
const { gatewayProviderBlock, insertProviderBlockIntoConfig, replaceGatewayProviderBlock } = require("../src/main/codex-cli-auth.cjs");
const {
  buildCodexQuotaHeaders,
  buildGatewayRequest,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  callWithFailover,
  extractTokenUsage,
  isAuthExpiredResponse,
  isQuotaExhaustedResponse,
  matchGatewayRoute,
  syncAccountUsageFromHeaders
} = require("../src/main/gateway.cjs");

test("pickGatewayAccount chooses the first enabled token account by priority order", () => {
  resetSelectionState();
  const account = pickGatewayAccount([
    { id: "disabled", enabled: false, access_token: "a", status: "active", quota_5h_used_percent: 0 },
    { id: "busy", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 80 },
    { id: "best", enabled: true, access_token: "c", status: "active", quota_5h_used_percent: 20, priority: 50 }
  ]);
  assert.equal(account.id, "best");
});

test("buildAuthorizeUrl uses the official Codex OAuth scope shape", () => {
  const url = new URL(buildAuthorizeUrl({
    issuer: "https://auth.openai.com",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirectUri: "http://localhost:1455/auth/callback",
    codeChallenge: "challenge",
    state: "state"
  }));
  assert.equal(url.searchParams.get("scope"), "openid profile email offline_access");
  assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.equal(url.searchParams.get("id_token_add_organizations"), "true");
  assert.equal(url.searchParams.get("originator"), "codex_cli_rs");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
});

test("pickGatewayAccount can exclude failed accounts", () => {
  resetSelectionState();
  const account = pickGatewayAccount([
    { id: "first", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 1 },
    { id: "second", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 20 }
  ], "", ["first"]);
  assert.equal(account.id, "second");
});

test("usageScore uses the highest active quota window", () => {
  assert.equal(usageScore({ quota_5h_used_percent: 12, quota_7d_used_percent: 34 }), 34);
});

test("quotaWindowExhausted marks accounts with a depleted window unavailable", () => {
  resetSelectionState();
  assert.equal(quotaWindowExhausted({ quota_5h_used_percent: 100, quota_7d_used_percent: 20 }), true);
  assert.equal(pickGatewayAccount([
    { id: "empty", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 100 },
    { id: "usable", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 50 }
  ]).id, "usable");
});

test("pickGatewayAccount keeps the current database account until exhausted", () => {
  resetSelectionState();
  const accounts = [
    { id: "less-used", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 10 },
    { id: "current", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 95 }
  ];
  assert.equal(pickGatewayAccount(accounts, "current").id, "current");
});

test("pickGatewayAccount falls back to fixed order when no current account exists", () => {
  resetSelectionState();
  const account = pickGatewayAccount([
    { id: "more-used", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 40 },
    { id: "less-used", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 15 }
  ]);
  assert.equal(account.id, "more-used");
});

test("pickGatewayAccount switches current account only when exhausted", () => {
  resetSelectionState();
  const accounts = [
    { id: "current", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 100 },
    { id: "next", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 40 }
  ];
  assert.equal(pickGatewayAccount(accounts, "current").id, "next");
});

test("pickGatewayAccount keeps low remaining accounts usable until exhausted", () => {
  resetSelectionState();
  const account = pickGatewayAccount([
    { id: "almost-empty", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 97 },
    { id: "least-empty", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 96 }
  ]);
  assert.equal(account.id, "almost-empty");
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
  assert.equal(
    buildUpstreamUrl("https://chatgpt.com/backend-api/codex", "/v1/messages/count_tokens"),
    "https://chatgpt.com/backend-api/codex/messages/count_tokens"
  );
});

test("buildUpstreamHeaders sends Codex account auth headers", () => {
  const headers = buildUpstreamHeaders(
    {
      host: "127.0.0.1:8436",
      authorization: "Bearer local",
      "x-codex-turn-state": "state",
      "user-agent": "codex_cli_rs/1.0.0",
      originator: "codex_cli_rs",
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-random-client-header": "keep",
      cookie: "sid=client",
      "proxy-authorization": "Bearer proxy",
      "openai-organization": "org_client",
      "openai-project": "proj_client",
      origin: "http://127.0.0.1:8436",
      referer: "http://127.0.0.1:8436/",
      "accept-encoding": "gzip"
    },
    { access_token: "upstream-token", account_id: "acc_123" },
    true,
    "/v1/responses"
  );
  assert.equal(headers.Authorization, "Bearer upstream-token");
  assert.equal(headers["ChatGPT-Account-ID"], "acc_123");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.accept, "text/event-stream");
  assert.equal(headers.originator, "codex_cli_rs");
  assert.equal(headers["user-agent"], "codex_cli_rs/1.0.0");
  assert.equal(headers["x-codex-turn-state"], "state");
  assert.equal(headers.host, undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["x-random-client-header"], "keep");
  assert.equal(headers.cookie, undefined);
  assert.equal(headers["proxy-authorization"], undefined);
  assert.equal(headers["openai-organization"], undefined);
  assert.equal(headers["openai-project"], undefined);
  assert.equal(headers.origin, undefined);
  assert.equal(headers.referer, undefined);
  assert.equal(headers["accept-encoding"], undefined);
});

test("buildUpstreamHeaders only replaces local auth and account headers", () => {
  const headers = buildUpstreamHeaders(
    { "user-agent": "OpenAI/JS", accept: "application/json" },
    { access_token: "upstream-token", workspace_id: "ws_123" },
    true,
    "/v1/responses"
  );
  assert.deepEqual(headers, {
    "user-agent": "OpenAI/JS",
    accept: "application/json",
    Authorization: "Bearer upstream-token",
    "ChatGPT-Account-ID": "ws_123"
  });
});

test("buildGatewayRequest keeps compact endpoint path", () => {
  const request = buildGatewayRequest(
    "https://chatgpt.com/backend-api/codex",
    "/v1/responses/compact",
    Buffer.from(JSON.stringify({ input: "compact" }))
  );
  assert.equal(request.path, "/v1/responses/compact");
  assert.equal(request.upstreamUrl, "https://chatgpt.com/backend-api/codex/responses/compact");
});

test("buildCodexQuotaHeaders rewrites quota headers from account pool", () => {
  const headers = buildCodexQuotaHeaders([
    {
      enabled: true,
      status: "active",
      access_token: "a",
      quota_5h_used_percent: 20,
      quota_5h_reset_at: 1_000,
      quota_7d_used_percent: 30,
      quota_7d_reset_at: 5_000
    },
    {
      enabled: true,
      status: "active",
      access_token: "b",
      quota_5h_used_percent: 40,
      quota_5h_reset_at: 900,
      quota_7d_used_percent: 50,
      quota_7d_reset_at: 4_000
    },
    {
      enabled: false,
      status: "active",
      access_token: "c",
      quota_5h_used_percent: 100,
      quota_5h_reset_at: 100,
      quota_7d_used_percent: 100,
      quota_7d_reset_at: 100
    }
  ], 500);
  assert.equal(headers["x-codex-primary-used-percent"], "0");
  assert.equal(headers["x-codex-primary-window-minutes"], "300");
  assert.equal(headers["x-codex-primary-reset-after-seconds"], "400");
  assert.equal(headers["x-codex-secondary-used-percent"], "0");
  assert.equal(headers["x-codex-secondary-window-minutes"], "10080");
  assert.equal(headers["x-codex-secondary-reset-after-seconds"], "3500");
  assert.equal(headers["x-codex-plan-type"], "unknown");
  assert.equal(headers["x-codex-active-limit"], "primary");
  assert.equal(headers["x-codex-credits-balance"], "0");
  assert.equal(headers["x-codex-credits-has-credits"], "false");
  assert.equal(headers["x-codex-credits-unlimited"], "false");
});

test("buildCodexQuotaHeaders caps stacked remaining quota before subtraction", () => {
  const headers = buildCodexQuotaHeaders([
    { enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 80, quota_5h_reset_at: 100 },
    { enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 50, quota_5h_reset_at: 200 }
  ], 500);
  assert.equal(headers["x-codex-primary-used-percent"], "30");
  assert.equal(headers["x-codex-primary-reset-after-seconds"], "0");
});

test("buildCodexQuotaHeaders subtracts stacked remaining quota from 100", () => {
  const headers = buildCodexQuotaHeaders([
    { enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 90 },
    { enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 80 }
  ], 500);
  assert.equal(headers["x-codex-primary-used-percent"], "70");
});

test("syncAccountUsageFromHeaders stores quota snapshots for the active account", () => {
  let updated = null;
  syncAccountUsageFromHeaders(
    { id: "active" },
    new Headers({
      "x-codex-primary-used-percent": "67.5",
      "x-codex-primary-reset-after-seconds": "120",
      "x-codex-secondary-used-percent": "12",
      "x-codex-secondary-reset-after-seconds": "240"
    }),
    {
      updateUsage(id, usage) {
        updated = { id, usage };
      }
    }
  );
  assert.equal(updated.id, "active");
  assert.equal(updated.usage.quota_5h_used_percent, 67.5);
  assert.equal(updated.usage.quota_7d_used_percent, 12);
  assert.ok(updated.usage.quota_5h_reset_at > Math.floor(Date.now() / 1000));
  assert.ok(updated.usage.quota_7d_reset_at > updated.usage.quota_5h_reset_at);
});

test("callWithFailover stores quota headers and switches current account after exhaustion", async () => {
  const originalFetch = globalThis.fetch;
  const accounts = [
    { id: "first", enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 50, quota_7d_used_percent: 20 },
    { id: "second", enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 10, quota_7d_used_percent: 20 }
  ];
  const savedSettings = [];
  let refreshAllCalled = false;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    const call = fetchCount;
    fetchCount += 1;
    if (call === 0) {
      return new Response("quota exceeded", {
        status: 429,
        headers: {
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-after-seconds": "1800"
        }
      });
    }
    return new Response("{}", { status: 200 });
  };
  try {
    const result = await callWithFailover(
      { method: "POST", headers: {} },
      { upstreamUrl: "https://example.test/responses", path: "/v1/responses", body: Buffer.from("{}") },
      accounts[0],
      {},
      {
        listAccounts: () => accounts,
        saveSettings: (patch) => savedSettings.push(patch),
        addAppLog: () => {},
        updateUsage(id, usage) {
          const account = accounts.find((item) => item.id === id);
          Object.assign(account, usage);
        }
      },
      {
        refreshAllUsage: async () => {
          refreshAllCalled = true;
        }
      }
    );
    assert.equal(result.account.id, "second");
    assert.equal(accounts[0].quota_5h_used_percent, 100);
    assert.equal(savedSettings.at(-1).gateway_current_account_id, "second");
    assert.equal(refreshAllCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callWithFailover marks no-header quota failures exhausted without saving a failed account", async () => {
  const originalFetch = globalThis.fetch;
  const accounts = [
    { id: "first", enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 50 },
    { id: "second", enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 10 }
  ];
  const savedSettings = [];
  globalThis.fetch = async () => new Response("quota exceeded", { status: 429 });
  try {
    const result = await callWithFailover(
      { method: "POST", headers: {} },
      { upstreamUrl: "https://example.test/responses", path: "/v1/responses", body: Buffer.from("{}") },
      accounts[0],
      {},
      {
        listAccounts: () => accounts,
        saveSettings: (patch) => savedSettings.push(patch),
        addAppLog: () => {},
        updateUsage(id, usage) {
          const account = accounts.find((item) => item.id === id);
          Object.assign(account, usage);
        }
      },
      {}
    );
    assert.equal(result.account.id, "second");
    assert.equal(accounts[0].quota_5h_used_percent, 100);
    assert.equal(accounts[1].quota_5h_used_percent, 100);
    assert.equal(savedSettings.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callWithFailover returns the last attempted account when all accounts fail", async () => {
  const originalFetch = globalThis.fetch;
  const accounts = [
    { id: "first", enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 50 },
    { id: "second", enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 10 }
  ];
  globalThis.fetch = async () => new Response("quota exceeded", { status: 429 });
  try {
    const result = await callWithFailover(
      { method: "POST", headers: {} },
      { upstreamUrl: "https://example.test/responses", path: "/v1/responses", body: Buffer.from("{}") },
      accounts[0],
      {},
      {
        listAccounts: () => accounts,
        saveSettings: () => {},
        addAppLog: () => {},
        updateUsage: () => {}
      },
      {}
    );
    assert.equal(result.account.id, "second");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callWithFailover can reach accounts beyond the first eight candidates", async () => {
  const originalFetch = globalThis.fetch;
  const accounts = Array.from({ length: 9 }, (_, index) => ({
    id: `account-${index + 1}`,
    enabled: true,
    status: "active",
    access_token: `token-${index + 1}`,
    quota_5h_used_percent: 10
  }));
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount < 9) return new Response("quota exceeded", { status: 429 });
    return new Response("{}", { status: 200 });
  };
  try {
    const result = await callWithFailover(
      { method: "POST", headers: {} },
      { upstreamUrl: "https://example.test/responses", path: "/v1/responses", body: Buffer.from("{}") },
      accounts[0],
      {},
      {
        listAccounts: () => accounts,
        saveSettings: () => {},
        addAppLog: () => {},
        updateUsage(id, usage) {
          const account = accounts.find((item) => item.id === id);
          Object.assign(account, usage);
        }
      },
      {}
    );
    assert.equal(result.account.id, "account-9");
    assert.equal(fetchCount, 9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("matchGatewayRoute validates both path and method", () => {
  assert.deepEqual(matchGatewayRoute("GET", "/v1/models"), {
    pathAllowed: true,
    methodAllowed: true,
    allowedMethods: ["GET"]
  });
  assert.deepEqual(matchGatewayRoute("GET", "/v1/responses"), {
    pathAllowed: true,
    methodAllowed: false,
    allowedMethods: ["POST"]
  });
  assert.deepEqual(matchGatewayRoute("POST", "/v1/unknown"), {
    pathAllowed: false,
    methodAllowed: false,
    allowedMethods: []
  });
});

test("extractTokenUsage uses latest SSE usage instead of summing cumulative events", () => {
  const usage = extractTokenUsage(Buffer.from([
    "data: {\"type\":\"response.in_progress\",\"response\":{\"usage\":{\"input_tokens\":1000,\"cached_input_tokens\":800,\"output_tokens\":10,\"total_tokens\":1010}}}\n\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1200,\"cached_input_tokens\":900,\"output_tokens\":20,\"total_tokens\":1220}}}\n\n",
    "data: [DONE]\n\n"
  ].join(""), "utf8"));
  assert.equal(usage.input_tokens, 1200);
  assert.equal(usage.cached_input_tokens, 900);
  assert.equal(usage.output_tokens, 20);
  assert.equal(usage.total_tokens, 1220);
});

test("isQuotaExhaustedResponse detects quota and rate limit failures", () => {
  assert.equal(isQuotaExhaustedResponse(429, Buffer.from('{"error":"rate_limit_exceeded"}')), true);
  assert.equal(isQuotaExhaustedResponse(403, Buffer.from('{"detail":"quota exceeded"}')), true);
  assert.equal(isQuotaExhaustedResponse(500, Buffer.from("rate_limit_exceeded")), false);
});

test("isAuthExpiredResponse detects expired token failures", () => {
  assert.equal(isAuthExpiredResponse(401, Buffer.from('{"error":"invalid_token"}')), true);
  assert.equal(isAuthExpiredResponse(403, Buffer.from('{"error":"token expired"}')), true);
  assert.equal(isAuthExpiredResponse(403, Buffer.from('{"detail":"quota exceeded"}')), false);
});

test("insertProviderBlockIntoConfig inserts at first blank line", () => {
  const current = [
    'model = "gpt-5.4"',
    "",
    "[notice.model_migrations]",
    '"gpt-5.3-codex" = "gpt-5.4"',
    "",
    "[profiles.default]",
    'approval_policy = "on-request"',
    ""
  ].join("\n");
  const block = [
    'model_provider = "codex_gateway"',
    "",
    "[model_providers.codex_gateway]",
    'base_url = "http://localhost:8436/v1"',
    ""
  ].join("\n");
  const next = insertProviderBlockIntoConfig(current, block);
  assert.match(next, /^model = "gpt-5\.4"\n\nmodel_provider = "codex_gateway"/);
  assert.match(next, /base_url = "http:\/\/localhost:8436\/v1"\n\n\[notice\.model_migrations\]/);
  assert.ok(next.indexOf('model_provider = "codex_gateway"') < next.indexOf("[notice.model_migrations]"));
});

test("gatewayProviderBlock uses OpenAI provider name for compact support", () => {
  const block = gatewayProviderBlock({ gateway_host: "localhost", gateway_port: "8436" });
  assert.match(block, /name = "OpenAI"/);
  assert.match(block, /wire_api = "responses"/);
});

test("replaceGatewayProviderBlock repairs existing provider name", () => {
  const current = [
    'model = "gpt-5.4"',
    "",
    'model_provider = "codex_gateway"',
    "",
    "[model_providers.codex_gateway]",
    'name = "Codex Gateway"',
    'base_url = "http://localhost:8436/v1"',
    'wire_api = "responses"',
    "",
    "[notice.model_migrations]",
    '"gpt-5.3-codex" = "gpt-5.4"',
    ""
  ].join("\n");
  const next = replaceGatewayProviderBlock(current, gatewayProviderBlock({ gateway_host: "localhost", gateway_port: "8436" }));
  assert.equal((next.match(/\[model_providers\.codex_gateway\]/g) || []).length, 1);
  assert.match(next, /name = "OpenAI"/);
  assert.doesNotMatch(next, /name = "Codex Gateway"/);
  assert.ok(next.indexOf('model_provider = "codex_gateway"') < next.indexOf("[notice.model_migrations]"));
});
