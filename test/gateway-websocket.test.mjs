import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";

import gatewayModule from "../src/main/gateway.cjs";

const { createGateway } = gatewayModule;

test("WebSocket gateway proxies compressed Responses messages and handshake metadata", async () => {
  const requests = [];
  let resolveUpstreamPong;
  const upstreamPong = new Promise((resolve) => {
    resolveUpstreamPong = resolve;
  });
  const harness = await startHarness({
    onHeaders(headers) {
      headers.push("x-codex-turn-state: ws-state-a");
      headers.push("x-codex-primary-used-percent: 12");
      headers.push("x-upstream-private: should-not-cross");
    },
    onConnection(websocket, request) {
      requests.push(request);
      websocket.once("pong", resolveUpstreamPong);
      websocket.ping("upstream-health");
      websocket.once("message", (data, isBinary) => {
        assert.equal(isBinary, false);
        websocket.send(`upstream:${data.toString()}`);
        websocket.send(JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 3, total_tokens: 15 } }
        }));
      });
    }
  });
  try {
    const { websocket, response } = await connectGateway(harness, "/v1/responses?stream=true", {
      "session-id": "session-1",
      "thread-id": "thread-1",
      "openai-beta": "responses_websockets=2026-02-06"
    });
    assert.match(websocket.extensions, /permessage-deflate/);
    assert.equal(response.headers["x-codex-turn-state"], "ws-state-a");
    assert.equal(response.headers["x-codex-primary-used-percent"], undefined);
    assert.equal(response.headers["x-upstream-private"], undefined);
    const pong = new Promise((resolve) => websocket.once("pong", resolve));
    websocket.ping("health");
    await pong;
    await withTimeout(upstreamPong, 1_000, "gateway did not answer the upstream ping");
    const messagesPromise = nextMessages(websocket, 2);
    const requestMessage = JSON.stringify({ type: "response.create", model: "gpt-test" });
    websocket.send(requestMessage);
    const messages = await messagesPromise;
    assert.equal(messages[0].toString(), `upstream:${requestMessage}`);
    assert.match(messages[1].toString(), /response\.completed/);
    websocket.close(1000, "done");
    await nextClose(websocket);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/backend-api/codex/responses?stream=true");
    assert.equal(requests[0].headers.authorization, "Bearer token-a");
    assert.equal(requests[0].headers["chatgpt-account-id"], "account-a");
    assert.equal(requests[0].headers["session-id"], "session-1");
    assert.equal(requests[0].headers["openai-beta"], "responses_websockets=2026-02-06");
    assert.match(harness.settings.gateway_affinity_state_json, /session-1/);
    await waitFor(() => harness.tokenLogs.length > 0, 1_000);
    assert.equal(harness.tokenLogs.at(-1).input_tokens, 12);
    assert.equal(harness.tokenLogs.at(-1).cached_input_tokens, 4);
    assert.equal(harness.tokenLogs.at(-1).total_tokens, 15);
    await waitFor(() => harness.appLogs.some((entry) => entry.action === "disconnect"), 1_000);
    const connectLog = harness.appLogs.find((entry) => entry.action === "connect" && entry.status === "success");
    const disconnectLog = harness.appLogs.find((entry) => entry.action === "disconnect");
    const connectionId = connectLog.message.match(/^\[([^\]]+)\]/)?.[1];
    assert.ok(connectionId);
    assert.match(disconnectLog.message, new RegExp(`^\\[${connectionId}\\]`));
    assert.equal(disconnectLog.status, "1000");
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway reuses one upstream connection for sequential and binary messages", async () => {
  let connections = 0;
  let completed = 0;
  const harness = await startHarness({
    onConnection(websocket) {
      connections += 1;
      websocket.on("message", (data, isBinary) => {
        if (isBinary) {
          websocket.send(data, { binary: true }, () => websocket.close(4001, "rotate"));
          return;
        }
        completed += 1;
        websocket.send(JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: completed, output_tokens: 1, total_tokens: completed + 1 } }
        }));
      });
    }
  }, { gateway_websocket_buffer_high_water_bytes: "16" });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "session-reuse" });
    for (let index = 0; index < 2; index += 1) {
      const response = nextMessage(websocket);
      websocket.send(JSON.stringify({ type: "response.create", input: [{ role: "user", content: `turn-${index}` }] }));
      assert.match((await response).toString(), /response\.completed/);
    }
    const binary = Buffer.alloc(256 * 1024, 7);
    const echoed = nextMessage(websocket);
    const closed = nextCloseDetail(websocket);
    websocket.send(binary, { binary: true });
    assert.deepEqual(await echoed, binary);
    assert.deepEqual(await closed, { code: 4001, reason: "rotate" });
    await waitFor(() => harness.tokenLogs.length === 2, 1_000);
    assert.equal(connections, 1);
    assert.equal(harness.tokenLogs[0].input_tokens, 1);
    assert.equal(harness.tokenLogs[1].input_tokens, 2);
    const logs = JSON.stringify([harness.appLogs, harness.tokenLogs]);
    assert.doesNotMatch(logs, /token-a|local-key|turn-0|turn-1/);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway enforces active connection and message-size limits", async () => {
  const concurrencyHarness = await startHarness({}, { gateway_max_concurrent_requests: "1" });
  try {
    const first = await connectGateway(concurrencyHarness, "/v1/responses", { "session-id": "session-limit-1" });
    const second = await connectFailure(concurrencyHarness, "/v1/responses", { "session-id": "session-limit-2" });
    assert.equal(second.statusCode, 503);
    first.websocket.close();
    await nextClose(first.websocket);
  } finally {
    await concurrencyHarness.close();
  }

  const payloadHarness = await startHarness({}, { gateway_websocket_max_payload_bytes: "64" });
  try {
    const { websocket } = await connectGateway(payloadHarness, "/v1/responses", { "session-id": "session-payload" });
    const closed = nextCloseDetail(websocket);
    websocket.send("x".repeat(128));
    assert.equal((await closed).code, 1009);
  } finally {
    await payloadHarness.close();
  }
});

test("WebSocket gateway refreshes an expired account before accepting the local upgrade", async () => {
  const attempts = [];
  const harness = await startHarness({
    hooks: {
      async refreshAccountToken(id) {
        assert.equal(id, "a");
        return account("a", "token-refreshed", 10);
      }
    },
    onUpgrade(request, socket, _head, accept) {
      attempts.push(request.headers.authorization);
      if (attempts.length === 1) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      accept();
    }
  });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "session-refresh" });
    websocket.close();
    await nextClose(websocket);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-refreshed"]);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway preserves the upstream 401 when token refresh itself fails", async () => {
  const harness = await startHarness({
    hooks: {
      async refreshAccountToken() {
        throw new Error("credential store unavailable");
      }
    },
    onUpgrade(_request, socket) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
  });
  try {
    const failure = await connectFailure(harness, "/v1/responses", { "session-id": "session-refresh-failure" });
    assert.equal(failure.statusCode, 401);
    assert.equal(harness.appLogs.some((entry) => entry.action === "refresh-token" && entry.status === "failed"), true);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway passes 426 through so Codex can fall back to HTTP", async () => {
  const harness = await startHarness({
    onUpgrade(_request, socket) {
      socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
  });
  try {
    const failure = await connectFailure(harness, "/v1/responses", { "session-id": "session-426" });
    assert.equal(failure.statusCode, 426);
  } finally {
    await harness.close();
  }
});

test("WebSocket rate-limit events update usage and quota errors affect only the next connection", async () => {
  const attempts = [];
  let firstConnection = true;
  const harness = await startHarness({
    onUpgrade(request, _socket, _head, accept) {
      attempts.push(request.headers.authorization);
      accept();
    },
    onConnection(websocket) {
      if (!firstConnection) return;
      firstConnection = false;
      websocket.once("message", () => {
        websocket.send(JSON.stringify({
          type: "codex.rate_limits",
          rate_limits: {
            primary: { used_percent: 50, window_minutes: 300, reset_at: 2_000_000_000 },
            secondary: { used_percent: 25, window_minutes: 10080, reset_at: 2_000_100_000 }
          }
        }));
        websocket.send(JSON.stringify({ type: "error", error: { code: "usage_limit_reached", message: "quota exceeded" } }));
      });
    }
  });
  try {
    const first = await connectGateway(harness, "/v1/responses", { "session-id": "session-quota-event" });
    const messages = nextMessages(first.websocket, 2);
    first.websocket.send(JSON.stringify({ type: "response.create" }));
    await messages;
    assert.equal(first.websocket.readyState, WebSocket.OPEN);
    first.websocket.close();
    await nextClose(first.websocket);
    assert.equal(harness.accounts[0].quota_5h_used_percent, 50);
    assert.equal(harness.accounts[0].quota_7d_used_percent, 25);

    const second = await connectGateway(harness, "/v1/responses", { "session-id": "session-quota-event" });
    second.websocket.close();
    await nextClose(second.websocket);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-b"]);
  } finally {
    await harness.close();
  }
});

test("WebSocket response idle timeout closes a stalled logical request", async () => {
  const harness = await startHarness({}, { gateway_websocket_idle_timeout_ms: "40" });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "session-idle" });
    const closed = nextClose(websocket);
    websocket.send(JSON.stringify({ type: "response.create" }));
    await withTimeout(closed, 1_000, "stalled WebSocket request was not closed");
    await waitFor(() => harness.appLogs.some((entry) => entry.status === "websocket_idle_timeout"), 1_000);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway validates local API key and route before upstream", async () => {
  let attempts = 0;
  const harness = await startHarness({
    onUpgrade(_request, _socket, _head, accept) {
      attempts += 1;
      accept();
    }
  });
  try {
    const unauthorized = await connectFailure(harness, "/v1/responses", { authorization: "Bearer wrong-key" });
    const unknownRoute = await connectFailure(harness, "/v1/unknown");
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unknownRoute.statusCode, 404);
    assert.equal(attempts, 0);
  } finally {
    await harness.close();
  }
});

test("WebSocket reconnect keeps its Session account until quota failover succeeds", async () => {
  const attempts = [];
  let accountAAttempts = 0;
  const harness = await startHarness({
    onUpgrade(request, socket, head, accept) {
      attempts.push(request.headers.authorization);
      if (request.headers.authorization === "Bearer token-a") accountAAttempts += 1;
      if (request.headers.authorization === "Bearer token-a" && accountAAttempts === 2) {
        socket.end([
          "HTTP/1.1 429 Too Many Requests",
          "Content-Type: application/json",
          "Content-Length: 26",
          "Connection: close",
          "",
          '{"error":"quota exceeded"}'
        ].join("\r\n"));
        return;
      }
      accept();
    }
  });
  try {
    const first = await connectGateway(harness, "/v1/responses", { "session-id": "session-1" });
    first.websocket.close();
    await nextClose(first.websocket);

    const second = await connectGateway(harness, "/v1/responses", { "session-id": "session-1" });
    second.websocket.close();
    await nextClose(second.websocket);

    const third = await connectGateway(harness, "/v1/responses", { "session-id": "session-1" });
    third.websocket.close();
    await nextClose(third.websocket);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-a", "Bearer token-b", "Bearer token-b"]);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway never moves an established Turn during handshake failure", async () => {
  const attempts = [];
  let connections = 0;
  const turnMetadata = JSON.stringify({ turn_id: "turn-1" });
  const harness = await startHarness({
    onUpgrade(request, socket, head, accept) {
      attempts.push(request.headers.authorization);
      connections += 1;
      if (connections === 2) {
        socket.end("HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      accept();
    }
  });
  try {
    const first = await connectGateway(harness, "/v1/responses", {
      "session-id": "session-1",
      "x-codex-turn-metadata": turnMetadata
    });
    first.websocket.close();
    await nextClose(first.websocket);

    const failure = await connectFailure(harness, "/v1/responses", {
      "session-id": "session-1",
      "x-codex-turn-metadata": turnMetadata
    });
    assert.equal(failure.statusCode, 429);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-a"]);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway rejects unknown Turn state before contacting upstream", async () => {
  let attempts = 0;
  const harness = await startHarness({
    onUpgrade(_request, _socket, _head, accept) {
      attempts += 1;
      accept();
    }
  });
  try {
    const failure = await connectFailure(harness, "/v1/responses", {
      "session-id": "session-1",
      "x-codex-turn-state": "unknown-state"
    });
    assert.equal(failure.statusCode, 409);
    assert.equal(attempts, 0);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway proxies Realtime and sideband query parameters", async () => {
  let upstreamPath = "";
  const harness = await startHarness({
    onConnection(websocket, request) {
      upstreamPath = request.url;
      websocket.once("message", (data) => websocket.send(data));
    }
  });
  try {
    const { websocket } = await connectGateway(harness, "/v1/realtime?call_id=rtc_test", {
      "x-session-id": "realtime-session"
    });
    websocket.send(JSON.stringify({ type: "session.update" }));
    assert.equal((await nextMessage(websocket)).toString(), JSON.stringify({ type: "session.update" }));
    websocket.close();
    await nextClose(websocket);
    assert.equal(upstreamPath, "/backend-api/codex/realtime?call_id=rtc_test");
    assert.match(harness.settings.gateway_affinity_state_json, /realtime-session/);
  } finally {
    await harness.close();
  }
});

test("gateway stop terminates active WebSockets within the shutdown grace period", async () => {
  const harness = await startHarness({});
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "session-1" });
    const closed = nextClose(websocket);
    const started = Date.now();
    await harness.gateway.stop();
    await withTimeout(closed, 1_000, "active WebSocket did not close during gateway stop");
    assert.ok(Date.now() - started < 500);
  } finally {
    await harness.close();
  }
});

async function startHarness(options, settingOverrides = {}) {
  const upstreamServer = http.createServer();
  const upstreamWebSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  upstreamWebSocketServer.on("headers", (headers, request) => options.onHeaders?.(headers, request));
  upstreamWebSocketServer.on("connection", (websocket, request) => options.onConnection?.(websocket, request));
  upstreamServer.on("upgrade", (request, socket, head) => {
    const accept = () => upstreamWebSocketServer.handleUpgrade(request, socket, head, (websocket) => {
      upstreamWebSocketServer.emit("connection", websocket, request);
    });
    if (options.onUpgrade) options.onUpgrade(request, socket, head, accept);
    else accept();
  });
  await listen(upstreamServer);
  const accounts = [account("a", "token-a", 10), account("b", "token-b", 20)];
  const settings = {
    gateway_host: "127.0.0.1",
    gateway_port: "0",
    gateway_api_key: "local-key",
    upstream_base_url: `http://127.0.0.1:${upstreamServer.address().port}/backend-api/codex`,
    gateway_connect_timeout_ms: "1000",
    gateway_shutdown_grace_ms: "100",
    gateway_error_body_limit_bytes: "65536",
    gateway_max_concurrent_requests: "16",
    gateway_websocket_max_payload_bytes: "134217728",
    gateway_websocket_buffer_high_water_bytes: "4194304",
    gateway_websocket_idle_timeout_ms: "1000",
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
  const gateway = createGateway(store, null, options.hooks || {});
  await gateway.start();
  return {
    gateway,
    settings,
    store,
    accounts,
    tokenLogs,
    appLogs,
    upstreamServer,
    upstreamWebSocketServer,
    async close() {
      await gateway.stop();
      for (const websocket of upstreamWebSocketServer.clients) websocket.terminate();
      await closeWebSocketServer(upstreamWebSocketServer);
      await closeServer(upstreamServer);
    }
  };
}

function connectGateway(harness, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(toWebSocketUrl(harness.gateway.status().url, path), {
      perMessageDeflate: true,
      headers: { authorization: "Bearer local-key", ...extraHeaders }
    });
    let response = null;
    websocket.once("upgrade", (value) => {
      response = value;
    });
    websocket.once("open", () => resolve({ websocket, response }));
    websocket.once("error", reject);
  });
}

function connectFailure(harness, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(toWebSocketUrl(harness.gateway.status().url, path), {
      headers: { authorization: "Bearer local-key", ...extraHeaders }
    });
    websocket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response);
    });
    websocket.once("open", () => reject(new Error("WebSocket unexpectedly connected")));
    websocket.once("error", () => {});
  });
}

function nextMessage(websocket) {
  return new Promise((resolve, reject) => {
    websocket.once("message", resolve);
    websocket.once("error", reject);
  });
}

function nextMessages(websocket, count) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const onMessage = (data) => {
      messages.push(data);
      if (messages.length < count) return;
      cleanup();
      resolve(messages);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      websocket.off("message", onMessage);
      websocket.off("error", onError);
    };
    websocket.on("message", onMessage);
    websocket.once("error", onError);
  });
}

function nextClose(websocket) {
  if (websocket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => websocket.once("close", resolve));
}

function nextCloseDetail(websocket) {
  return new Promise((resolve) => websocket.once("close", (code, reason) => resolve({
    code,
    reason: reason.toString()
  })));
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

function toWebSocketUrl(baseUrl, path) {
  return `${baseUrl.replace(/^http/, "ws")}${path}`;
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

function closeWebSocketServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
