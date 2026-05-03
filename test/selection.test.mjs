import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickGatewayAccount, quotaWindowExhausted, usageScore } = require("../src/main/selection.cjs");
const { buildAuthorizeUrl } = require("../src/main/auth.cjs");
const { gatewayProviderBlock, insertProviderBlockIntoConfig, replaceGatewayProviderBlock } = require("../src/main/codex-cli-auth.cjs");
const {
  applyResponseAdapter,
  buildGatewayRequest,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  isAuthExpiredResponse,
  isQuotaExhaustedResponse
} = require("../src/main/gateway.cjs");

test("pickGatewayAccount chooses enabled token account with lowest quota usage", () => {
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
  assert.equal(url.searchParams.get("scope"), "openid profile email offline_access api.connectors.read api.connectors.invoke");
  assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.equal(url.searchParams.get("id_token_add_organizations"), "true");
  assert.equal(url.searchParams.get("originator"), "codex_cli_rs");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
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
      "x-random-client-header": "drop"
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
  assert.equal(headers["x-random-client-header"], "drop");
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

test("buildGatewayRequest converts chat function tools to Responses format", () => {
  const request = buildGatewayRequest(
    "https://chatgpt.com/backend-api/codex",
    "/v1/chat/completions",
    Buffer.from(JSON.stringify({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", description: "lookup", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "lookup" } }
    }))
  );
  const body = JSON.parse(request.body.toString("utf8"));
  assert.equal(request.path, "/v1/responses");
  assert.deepEqual(body.tools, [{ type: "function", name: "lookup", description: "lookup", parameters: { type: "object" } }]);
  assert.deepEqual(body.tool_choice, { type: "function", name: "lookup" });
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

test("buildGatewayRequest adapts images generation to Responses image tool", () => {
  const request = buildGatewayRequest(
    "https://chatgpt.com/backend-api/codex",
    "/v1/images/generations",
    Buffer.from(JSON.stringify({
      model: "gpt-image-2",
      prompt: "a cat",
      response_format: "url",
      size: "1024x1024",
      partial_images: 1
    }))
  );
  const body = JSON.parse(request.body.toString("utf8"));
  assert.equal(request.path, "/v1/responses");
  assert.equal(request.responseAdapter.type, "images");
  assert.equal(request.responseAdapter.responseFormat, "url");
  assert.equal(body.stream, true);
  assert.equal(body.tools[0].type, "image_generation");
  assert.equal(body.tools[0].model, "gpt-image-2");
  assert.equal(body.tools[0].size, "1024x1024");
  assert.equal(body.tools[0].partial_images, 1);
  assert.deepEqual(body.tool_choice, { type: "image_generation" });
});

test("buildGatewayRequest adapts multipart image edits", () => {
  const multipart = Buffer.from([
    "--test-boundary\r\n",
    "Content-Disposition: form-data; name=\"prompt\"\r\n\r\n",
    "edit it\r\n",
    "--test-boundary\r\n",
    "Content-Disposition: form-data; name=\"image\"; filename=\"a.png\"\r\n",
    "Content-Type: image/png\r\n\r\n",
    "IMG\r\n",
    "--test-boundary\r\n",
    "Content-Disposition: form-data; name=\"mask\"; filename=\"m.png\"\r\n",
    "Content-Type: image/png\r\n\r\n",
    "MSK\r\n",
    "--test-boundary--\r\n"
  ].join(""), "utf8");
  const request = buildGatewayRequest(
    "https://chatgpt.com/backend-api/codex",
    "/v1/images/edits",
    multipart,
    { "content-type": "multipart/form-data; boundary=test-boundary" }
  );
  const body = JSON.parse(request.body.toString("utf8"));
  assert.equal(body.input[0].content[1].image_url, "data:image/png;base64,SU1H");
  assert.equal(body.tools[0].input_image_mask.image_url, "data:image/png;base64,TVNL");
});

test("applyResponseAdapter converts Codex image SSE to OpenAI Images JSON", () => {
  const upstream = {
    status: 200,
    headers: [["content-type", "text/event-stream"]],
    tokenUsage: {},
    body: Buffer.from([
      "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"image_generation_call\",\"status\":\"completed\",\"output_format\":\"png\",\"result\":\"aGVsbG8=\",\"revised_prompt\":\"cat\"}}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"created\":1775900000,\"usage\":{\"input_tokens\":4,\"output_tokens\":1,\"total_tokens\":5}}}\n\n",
      "data: [DONE]\n\n"
    ].join(""), "utf8")
  };
  const converted = applyResponseAdapter(
    { responseAdapter: { type: "images", responseFormat: "b64_json", stream: false } },
    upstream
  );
  const body = JSON.parse(converted.body.toString("utf8"));
  assert.equal(converted.headers[0][1], "application/json; charset=utf-8");
  assert.equal(body.created, 1775900000);
  assert.equal(body.data[0].b64_json, "aGVsbG8=");
  assert.equal(body.data[0].revised_prompt, "cat");
  assert.equal(body.usage.total_tokens, 5);
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
