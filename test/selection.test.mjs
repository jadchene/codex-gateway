import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickGatewayAccount, quotaWindowExhausted, resetSelectionState, usageScore } = require("../src/main/selection.cjs");
const { buildAuthorizeUrl } = require("../src/main/auth.cjs");
const { gatewayProviderBlock, insertProviderBlockIntoConfig, replaceGatewayProviderBlock } = require("../src/main/codex-cli-auth.cjs");
const {
  buildGatewayRequest,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  extractTokenUsage,
  isAuthExpiredResponse,
  isQuotaExhaustedResponse,
  matchGatewayRoute
} = require("../src/main/gateway.cjs");

test("pickGatewayAccount chooses enabled token account with lowest quota usage", () => {
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
  ], ["first"]);
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

test("pickGatewayAccount rotates full 5h remaining accounts first", () => {
  resetSelectionState();
  const accounts = [
    { id: "full-a", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 0 },
    { id: "full-b", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 0 },
    { id: "partial", enabled: true, access_token: "c", status: "active", quota_5h_used_percent: 10 }
  ];
  assert.equal(pickGatewayAccount(accounts).id, "full-a");
  assert.equal(pickGatewayAccount(accounts).id, "full-b");
  assert.equal(pickGatewayAccount(accounts).id, "full-a");
});

test("pickGatewayAccount falls back to lower 5h usage when no full account exists", () => {
  resetSelectionState();
  const account = pickGatewayAccount([
    { id: "more-used", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 40 },
    { id: "less-used", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 15 }
  ]);
  assert.equal(account.id, "less-used");
});

test("pickGatewayAccount sticks to a healthy partial account", () => {
  resetSelectionState();
  const accounts = [
    { id: "first", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 20 },
    { id: "second", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 30 }
  ];
  assert.equal(pickGatewayAccount(accounts).id, "first");
  assert.equal(pickGatewayAccount(accounts).id, "first");
});

test("pickGatewayAccount switches away when remaining 5h quota is below threshold", () => {
  resetSelectionState();
  assert.equal(pickGatewayAccount([
    { id: "current", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 20 }
  ]).id, "current");
  assert.equal(pickGatewayAccount([
    { id: "current", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 96 },
    { id: "next", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 40 }
  ]).id, "next");
});

test("pickGatewayAccount uses low remaining accounts only when unavoidable", () => {
  resetSelectionState();
  const account = pickGatewayAccount([
    { id: "almost-empty", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 97 },
    { id: "least-empty", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 96 }
  ]);
  assert.equal(account.id, "least-empty");
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
