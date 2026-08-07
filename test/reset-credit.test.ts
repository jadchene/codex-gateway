import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildConsumeRequestBody,
  isConsumeSuccess,
  normalizeConsumeResult,
  parseStoredResetCredits,
  pickAvailableResetCredit,
  pickResetCreditById,
  requestResetCreditConsume
} from "../src/main/reset-credit.ts";

test("parseStoredResetCredits reads the normalized credits array", () => {
  const credits = parseStoredResetCredits(JSON.stringify({
    available_count: 1,
    credits: [{ id: "credit-1", status: "available", expires_at: 100 }]
  }));
  assert.equal(credits.length, 1);
  assert.equal(credits[0].id, "credit-1");
  assert.deepEqual(parseStoredResetCredits("not json"), []);
  assert.deepEqual(parseStoredResetCredits(JSON.stringify({ available_count: 0 })), []);
});

test("pickAvailableResetCredit prefers the earliest-expiring available credit", () => {
  const credits = [
    { id: "late", status: "available", expires_at: 200 },
    { id: "early", status: "available", expires_at: 100 },
    { id: "used", status: "used", expires_at: 50 },
    { id: "expired", status: "expired", expires_at: 10 }
  ];
  assert.equal(pickAvailableResetCredit(credits)?.id, "early");
});

test("pickAvailableResetCredit sorts credits without expiry after those with expiry", () => {
  const credits = [
    { id: "no-expiry", status: "available" },
    { id: "with-expiry", status: "available", expires_at: 300 }
  ];
  assert.equal(pickAvailableResetCredit(credits)?.id, "with-expiry");
});

test("pickAvailableResetCredit returns null without an available credit", () => {
  assert.equal(pickAvailableResetCredit([]), null);
  assert.equal(pickAvailableResetCredit([{ id: "used", status: "used" }]), null);
  assert.equal(pickAvailableResetCredit(null), null);
});

test("pickResetCreditById finds the requested credit and rejects missing ids", () => {
  const credits = [
    { id: "credit-a", status: "available" },
    { id: "credit-b", status: "used" }
  ];
  assert.equal(pickResetCreditById(credits, "credit-b")?.id, "credit-b");
  assert.equal(pickResetCreditById(credits, "missing"), null);
  assert.equal(pickResetCreditById(credits, ""), null);
  assert.equal(pickResetCreditById(null, "credit-a"), null);
});

test("buildConsumeRequestBody creates a UUID v4 and includes the credit id", () => {
  const body = buildConsumeRequestBody({ id: "credit-1", status: "available" });
  assert.match(body.redeem_request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(body.credit_id, "credit-1");
});

test("buildConsumeRequestBody omits credit_id when no credit is available", () => {
  const body = buildConsumeRequestBody(null);
  assert.match(body.redeem_request_id, /^[0-9a-f-]{36}$/);
  assert.equal("credit_id" in body, false);
});

test("normalizeConsumeResult maps the four documented results and rejects unknown payloads", () => {
  assert.deepEqual(normalizeConsumeResult({ code: "reset", windows_reset: 2 }), { status: "reset", message: "重置成功" });
  assert.deepEqual(normalizeConsumeResult({ result: "reset" }), { status: "reset", message: "重置成功" });
  assert.deepEqual(normalizeConsumeResult({ status: "already_redeemed" }), {
    status: "already_redeemed",
    message: "该重置请求已执行过，按成功处理"
  });
  assert.deepEqual(normalizeConsumeResult({ data: { result: "nothing_to_reset" } }), {
    status: "nothing_to_reset",
    message: "当前额度无需重置"
  });
  assert.deepEqual(normalizeConsumeResult({ result: "no_credit" }), {
    status: "no_credit",
    message: "没有可用重置卡"
  });
  assert.equal(normalizeConsumeResult({ unexpected: true }).status, "error");
  assert.equal(normalizeConsumeResult(null).status, "error");
  assert.equal(isConsumeSuccess("reset"), true);
  assert.equal(isConsumeSuccess("already_redeemed"), true);
  assert.equal(isConsumeSuccess("nothing_to_reset"), false);
});

test("requestResetCreditConsume posts the body with Codex headers and parses the payload", async () => {
  let captured: Record<string, unknown> = {};
  const fetchImpl = async (url: unknown, init: RequestInit) => {
    captured = { url: String(url), method: init.method, headers: init.headers, body: init.body };
    return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const payload = await requestResetCreditConsume({
    fetchImpl: fetchImpl as typeof fetch,
    endpoint: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    account: { access_token: "token-1", account_id: "account-1" },
    body: { redeem_request_id: "uuid", credit_id: "credit-1" }
  });
  assert.deepEqual(payload, { code: "reset", windows_reset: 2 });
  assert.equal(captured.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
  assert.equal(captured.method, "POST");
  assert.equal(JSON.parse(String(captured.body)).credit_id, "credit-1");
  assert.equal(JSON.parse(String(captured.body)).redeem_request_id, "uuid");
  const headers = captured.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer token-1");
  assert.equal(headers["ChatGPT-Account-Id"], "account-1");
  assert.equal(headers["content-type"], "application/json");
});

test("requestResetCreditConsume throws with the HTTP status on non-2xx responses", async () => {
  const fetchImpl = async () => new Response("quota exceeded", { status: 429 });
  await assert.rejects(
    requestResetCreditConsume({
      fetchImpl: fetchImpl as typeof fetch,
      endpoint: "https://example.test/consume",
      account: { access_token: "token-1" },
      body: { redeem_request_id: "uuid" }
    }),
    /429 quota exceeded/
  );
});
