import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createGateway } = require("../src/main/gateway.cjs");

test("HTTP gateway streams SSE unchanged and preserves turn state", async () => {
  const harness = await startHarness((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-codex-turn-state": "state-a"
    });
    res.write('data: {"type":"response.in_progress"}\n\n');
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n');
  });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("session-1", "turn-1")
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-codex-turn-state"), "state-a");
    assert.equal(await response.text(), [
      'data: {"type":"response.in_progress"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n'
    ].join(""));
    assert.equal(harness.tokenLogs.at(-1).total_tokens, 5);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway rewrites account quota headers with the aggregate pool quota", async () => {
  const harness = await startHarness((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-codex-primary-used-percent": "90",
      "x-codex-secondary-used-percent": "95"
    });
    res.end('data: {"type":"response.completed"}\n\n');
  }, { codex_quota_headers_mode: "rewrite" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("session-rewrite-quota", "turn-rewrite-quota")
    });
    assert.equal(response.headers.get("x-codex-primary-used-percent"), "10");
    assert.equal(response.headers.get("x-codex-secondary-used-percent"), "15");
    assert.equal(await response.text(), 'data: {"type":"response.completed"}\n\n');
    assert.equal(harness.accounts[0].quota_5h_used_percent, 90);
    assert.equal(harness.accounts[0].quota_7d_used_percent, 95);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway removes hop-by-hop, connection-nominated, and cookie response headers", async () => {
  const harness = await startHarness((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      connection: "keep-alive, x-upstream-hop",
      "keep-alive": "timeout=99",
      "x-upstream-hop": "secret",
      "set-cookie": "session=upstream",
      "x-codex-turn-state": "safe-state"
    });
    res.end("{}");
  });
  try {
    const response = await gatewayFetch(harness, "/v1/responses/compact", {
      headers: codexHeaders("session-headers", "turn-headers")
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-codex-turn-state"), "safe-state");
    assert.equal(response.headers.get("x-upstream-hop"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.notEqual(response.headers.get("keep-alive"), "timeout=99");
  } finally {
    await harness.close();
  }
});

test("HTTP gateway keeps a session account until quota exhaustion then changes the session preference", async () => {
  const attempts = [];
  let accountAResponses = 0;
  const harness = await startHarness((req, res) => {
    const token = req.headers.authorization;
    attempts.push(token);
    if (token === "Bearer token-a") accountAResponses += 1;
    if (token === "Bearer token-a" && accountAResponses === 2) {
      res.writeHead(429, {
        "content-type": "application/json",
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-after-seconds": "1800"
      });
      return res.end('{"error":"quota exceeded"}');
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end('data: {"type":"response.completed"}\n\n');
  });
  try {
    assert.equal((await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") })).status, 200);
    assert.equal((await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-2") })).status, 200);
    assert.equal((await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-3") })).status, 200);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-a", "Bearer token-b", "Bearer token-b"]);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway never moves an established turn to another account", async () => {
  const attempts = [];
  let calls = 0;
  const harness = await startHarness((req, res) => {
    attempts.push(req.headers.authorization);
    calls += 1;
    if (calls === 1) {
      res.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": "sticky-a" });
      return res.end('data: {"type":"response.completed"}\n\n');
    }
    res.writeHead(429, { "content-type": "application/json" });
    return res.end('{"error":"quota exceeded"}');
  });
  try {
    const first = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    await first.text();
    const second = await gatewayFetch(harness, "/v1/responses", {
      headers: {
        ...codexHeaders("session-1", "turn-1"),
        "x-codex-turn-state": "sticky-a"
      }
    });
    assert.equal(second.status, 429);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-a"]);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway rejects an unknown turn state instead of guessing an account", async () => {
  let upstreamCalls = 0;
  const harness = await startHarness((req, res) => {
    upstreamCalls += 1;
    res.end("unexpected");
  });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: {
        ...codexHeaders("session-1", "turn-1"),
        "x-codex-turn-state": "unknown-state"
      }
    });
    assert.equal(response.status, 409);
    assert.equal(upstreamCalls, 0);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway restores turn affinity after a gateway restart", async () => {
  const attempts = [];
  const harness = await startHarness((req, res) => {
    attempts.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": "persisted-state" });
    res.end('data: {"type":"response.completed"}\n\n');
  });
  let restarted = null;
  try {
    const first = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    await first.text();
    await harness.gateway.stop();

    restarted = createGateway(harness.store, null, {});
    await restarted.start();
    const second = await fetch(`${restarted.status().url}/v1/responses`, {
      method: "POST",
      headers: {
        ...codexHeaders("session-1", "turn-1"),
        "x-codex-turn-state": "persisted-state"
      },
      body: "{}"
    });
    assert.equal(second.status, 200);
    await second.text();
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-a"]);
  } finally {
    await restarted?.stop();
    await harness.close();
  }
});

test("HTTP gateway rejects oversized request bodies before contacting upstream", async () => {
  let upstreamCalls = 0;
  const harness = await startHarness((req, res) => {
    upstreamCalls += 1;
    res.end("unexpected");
  }, { gateway_request_body_limit_bytes: "8" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      body: "0123456789",
      headers: codexHeaders("session-1", "turn-1")
    });
    assert.equal(response.status, 413);
    assert.equal(upstreamCalls, 0);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway enforces the configured concurrent request limit", async () => {
  let upstreamCalls = 0;
  const harness = await startHarness((req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.in_progress"}\n\n');
  }, { gateway_max_concurrent_requests: "1" });
  try {
    const first = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    const second = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-2", "turn-2") });
    assert.equal(second.status, 503);
    assert.equal(upstreamCalls, 1);
    await first.body.cancel();
  } finally {
    await harness.close();
  }
});

test("HTTP gateway caps buffered upstream error bodies", async () => {
  const harness = await startHarness((req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("x".repeat(1024));
  }, { gateway_error_body_limit_bytes: "32" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    assert.equal(response.status, 500);
    assert.equal((await response.text()).length, 32);
  } finally {
    await harness.close();
  }
});

test("HTTP client disconnect aborts the active upstream response", async () => {
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => {
    resolveUpstreamClosed = resolve;
  });
  const harness = await startHarness((req, res) => {
    res.on("close", resolveUpstreamClosed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.in_progress"}\n\n');
  });
  try {
    await abortAfterFirstChunk(`${harness.gateway.status().url}/v1/responses`, codexHeaders("session-1", "turn-1"));
    await withTimeout(upstreamClosed, 1_000, "upstream response was not cancelled");
    assert.equal(harness.appLogs.some((entry) => entry.status === "client_cancelled"), true);
  } finally {
    await harness.close();
  }
});

test("HTTP client abort during request upload does not hang or contact upstream", async () => {
  let upstreamCalls = 0;
  const harness = await startHarness((req, res) => {
    upstreamCalls += 1;
    res.end("unexpected");
  });
  try {
    await abortDuringUpload(`${harness.gateway.status().url}/v1/responses`, codexHeaders("session-1", "turn-1"));
    await waitFor(() => harness.appLogs.some((entry) => entry.status === "client_cancelled"), 1_000);
    assert.equal(upstreamCalls, 0);
  } finally {
    await harness.close();
  }
});

test("HTTP streaming idle timeout ends a stalled upstream response", async () => {
  const harness = await startHarness((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.in_progress"}\n\n');
  }, { gateway_stream_idle_timeout_ms: "40" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    await withTimeout(response.text(), 1_000, "gateway did not end the idle response");
    assert.equal(harness.appLogs.some((entry) => entry.status === "stream_idle_timeout"), true);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway applies a separate upstream connection timeout", async () => {
  const harness = await startHarness(() => {}, { gateway_connect_timeout_ms: "40" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    assert.equal(response.status, 502);
    assert.equal(harness.appLogs.some((entry) => entry.status === "connect_timeout"), true);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway applies a unary total timeout independently from stream idle timeout", async () => {
  const harness = await startHarness((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
  }, { gateway_unary_timeout_ms: "40", gateway_stream_idle_timeout_ms: "1000" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses/compact", { headers: codexHeaders("session-1", "turn-1") });
    await withTimeout(response.text(), 1_000, "unary timeout did not end the response");
    assert.equal(harness.appLogs.some((entry) => entry.status === "unary_timeout"), true);
  } finally {
    await harness.close();
  }
});

test("gateway stop aborts active requests and completes within its grace period", async () => {
  let resolveUpstreamStarted;
  const upstreamStarted = new Promise((resolve) => {
    resolveUpstreamStarted = resolve;
  });
  const harness = await startHarness(() => {
    resolveUpstreamStarted();
  }, { gateway_shutdown_grace_ms: "50" });
  try {
    const pending = gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") }).catch(() => null);
    await withTimeout(upstreamStarted, 1_000, "upstream request did not start");
    const started = Date.now();
    await harness.gateway.stop();
    assert.ok(Date.now() - started < 500);
    await pending;
  } finally {
    await harness.close();
  }
});

test("gateway can retry startup after its configured port was temporarily occupied", async () => {
  const occupied = http.createServer();
  await listen(occupied);
  const settings = {
    gateway_host: "127.0.0.1",
    gateway_port: String(occupied.address().port),
    gateway_api_key: "local-key",
    gateway_shutdown_grace_ms: "100",
    gateway_affinity_state_json: "{}"
  };
  const store = {
    getSettings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    listAccounts: () => [],
    addAppLog: () => {}
  };
  const gateway = createGateway(store, null, {});
  try {
    await assert.rejects(gateway.start(), /EADDRINUSE/);
    assert.equal(gateway.status().running, false);
    assert.match(gateway.status().error, /EADDRINUSE/);
    await closeServer(occupied);
    await gateway.start();
    assert.equal(gateway.status().running, true);
  } finally {
    await gateway.stop();
    await closeServer(occupied);
  }
});

test("optional Codex HTTP endpoints are explicitly proxied", async () => {
  const paths = [];
  const harness = await startHarness((req, res) => {
    paths.push(req.url);
    res.writeHead(200, { "content-type": "application/json", location: "/v1/realtime/calls/call-1" });
    res.end("{}");
  });
  try {
    for (const path of [
      "/v1/memories/trace_summarize",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/realtime/calls"
    ]) {
      const response = await gatewayFetch(harness, path, { headers: codexHeaders("session-1", "turn-1") });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.deepEqual(paths, [
      "/backend-api/codex/memories/trace_summarize",
      "/backend-api/codex/images/generations",
      "/backend-api/codex/images/edits",
      "/backend-api/codex/realtime/calls"
    ]);
  } finally {
    await harness.close();
  }
});

function codexHeaders(sessionId, turnId) {
  return {
    authorization: "Bearer local-key",
    "content-type": "application/json",
    session_id: sessionId,
    "x-codex-turn-metadata": JSON.stringify({ turn_id: turnId })
  };
}

function gatewayFetch(harness, path, options = {}) {
  return fetch(`${harness.gateway.status().url}${path}`, {
    method: "POST",
    headers: options.headers,
    body: options.body ?? "{}"
  });
}

async function startHarness(upstreamHandler, settingOverrides = {}) {
  const upstream = http.createServer(upstreamHandler);
  await listen(upstream);
  const upstreamPort = upstream.address().port;
  const accounts = [
    account("a", "token-a", 10),
    account("b", "token-b", 20)
  ];
  const settings = {
    gateway_host: "127.0.0.1",
    gateway_port: "0",
    gateway_api_key: "local-key",
    upstream_base_url: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    gateway_connect_timeout_ms: "1000",
    gateway_stream_idle_timeout_ms: "1000",
    gateway_unary_timeout_ms: "1000",
    gateway_shutdown_grace_ms: "100",
    gateway_request_body_limit_bytes: "1048576",
    gateway_error_body_limit_bytes: "65536",
    gateway_max_concurrent_requests: "16",
    gateway_quota_cooldown_ms: "1000",
    codex_quota_headers_mode: "block",
    ...settingOverrides
  };
  const tokenLogs = [];
  const appLogs = [];
  const store = {
    getSettings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    listAccounts: () => accounts,
    updateUsage(id, usage) {
      Object.assign(accounts.find((item) => item.id === id), usage);
    },
    addTokenLog: (entry) => tokenLogs.push(entry),
    addAppLog: (entry) => appLogs.push(entry)
  };
  const gateway = createGateway(store, null, {});
  await gateway.start();
  return {
    gateway,
    store,
    upstream,
    accounts,
    tokenLogs,
    appLogs,
    async close() {
      await gateway.stop();
      await closeServer(upstream);
    }
  };
}

function account(id, token, usage) {
  return {
    id,
    enabled: true,
    status: "active",
    access_token: token,
    account_id: `account-${id}`,
    quota_5h_used_percent: usage,
    quota_7d_used_percent: usage,
    priority: 100
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function abortAfterFirstChunk(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST", headers }, (response) => {
      response.once("data", () => {
        response.destroy();
        resolve();
      });
    });
    request.once("error", (error) => {
      if (error.code === "ECONNRESET") resolve();
      else reject(error);
    });
    request.end("{}");
  });
}

function abortDuringUpload(url, headers) {
  return new Promise((resolve) => {
    const request = http.request(url, {
      method: "POST",
      headers: { ...headers, "content-length": "100" }
    });
    request.on("error", () => resolve());
    request.write("partial");
    setTimeout(() => {
      request.destroy();
      resolve();
    }, 10);
  });
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);
}
