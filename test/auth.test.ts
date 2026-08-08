import assert from "node:assert/strict";
import { test } from "vitest";
import { createAuthService } from "../src/main/auth.ts";

test("cancelled browser login cannot complete its callback", async () => {
  const sessions = new Map<string, Record<string, unknown>>([
    ["login-1", {
      id: "login-1",
      redirect_uri: "http://localhost:1455/auth/callback",
      code_verifier: "verifier",
      status: "pending",
      error: null
    }]
  ]);
  const service = createAuthService({
    saveLoginSession: (session) => sessions.set(String(session.id), { ...session }),
    getLoginSession: (id) => sessions.get(id) as never,
    updateLoginSession: (id, status, error) => sessions.set(id, { ...sessions.get(id), status, error }),
    saveAccount: (account) => account as never,
    listAccounts: () => [],
    addAppLog: () => undefined
  }, async () => undefined);

  assert.deepEqual(service.cancelLogin("login-1"), { cancelled: true });
  assert.equal(service.loginStatus("login-1").status, "cancelled");
  assert.deepEqual(service.cancelLogin("login-1"), { cancelled: false });
  await assert.rejects(
    service.completeCallback(new URLSearchParams({ state: "login-1", code: "unused" })),
    /登录授权已取消/
  );
});
