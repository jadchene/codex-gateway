# Codex Gateway

[中文文档](README_zh.md)

Codex Gateway is a local desktop app for managing personal Codex/ChatGPT login state, switching local Codex CLI authentication modes, viewing quota information, and running local gateway services.

It is built with Electron, React, Vite, and local SQLite storage. It is intended for personal local development workflows where you want one place to manage accounts, gateway state, Codex CLI auth files, request records, and local MCP gateway process control.

## Features

- Manage personal accounts through browser OAuth or by importing an existing local Codex auth file.
- View 5-hour and 7-day quota windows and refresh usage manually, on a timer, or before gateway failover.
- Switch the local Codex CLI between gateway mode and direct account mode.
- Run a local OpenAI-compatible `/v1` gateway for Codex-oriented routes.
- Start and stop an external `mcp-gateway-service` process in Streamable HTTP mode.
- Store gateway call records with path, upstream path, account, session ID, duration, status, and token usage.
- Save, name, search, and delete Codex session IDs from call records.
- Review local runtime logs for auth writes, gateway events, usage refreshes, and failures.
- Configure ports, local API keys, startup behavior, tray behavior, display billing factors, and log cleanup.
- Keep one desktop instance running; launching it again focuses the existing window.

## Why Use It

- Keep Codex-related local state in one app instead of editing `~/.codex/auth.json` and `~/.codex/config.toml` by hand.
- Reduce manual account switching during personal development by trying another available account when one account hits auth, quota, or rate-limit errors.
- Keep request history, session names, quota snapshots, and runtime logs in a local SQLite database.
- Control the Codex gateway and MCP gateway process separately from the same interface.

## Quick Start

Install dependencies and start the desktop app:

```bash
npm install
npm run dev
```

The renderer development server runs at:

```text
http://127.0.0.1:8435
```

Typical first-time flow:

1. Open the app and add a personal account from the Accounts page.
2. Start the Codex gateway from Gateway Services.
3. Open Auth Management and apply Gateway mode.
4. Use the Codex CLI normally; it will call the local gateway provider written by the app.
5. Review quota, call records, sessions, and logs from the app when needed.

## Codex Gateway API

The built-in gateway exposes a small OpenAI-compatible local surface:

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/memories/trace_summarize`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/realtime/calls`
- `WS /v1/responses`
- `WS /v1/realtime` (including Realtime sideband `call_id` connections)

Default local settings:

```text
host: localhost
port: 8436
base URL: http://localhost:8436/v1
API key: randomly generated on first run
```

The API key, host, port, HTTP body limits, WebSocket message/buffer limits, and connection/stream/unary/WebSocket idle timeouts can be changed in the app settings. The gateway forwards requests to the configured upstream Codex backend, replaces upstream `Authorization` and `ChatGPT-Account-ID`, preserves Codex application metadata, and removes hop-by-hop, cookie, and client credential headers.

Account routing uses soft session affinity and strict turn affinity. A Codex session keeps its preferred account across turns. When that account is exhausted or temporarily unavailable, the next unbound turn or a new WebSocket handshake can fail over and update the session preference. Requests carrying an established `x-codex-turn-state` and established WebSocket connections never move to another account. Client disconnects cancel the upstream request or socket, and gateway shutdown aborts active traffic before forcing any remaining sockets closed after the configured grace period.

Responses WebSocket transport and Realtime/sideband WebSocket transport are both proxied. The gateway negotiates compression independently on each side, preserves Codex application headers and handshake metadata, forwards text and binary messages in both directions with backpressure, propagates close semantics, and records usage found in WebSocket response events.

## Codex CLI Auth Modes

Auth Management supports two modes:

- Gateway mode writes a local `OPENAI_API_KEY` to `~/.codex/auth.json` and ensures `~/.codex/config.toml` contains a `codex_gateway` provider.
- Account mode writes the selected local account token to `~/.codex/auth.json` and removes the gateway provider written by this app.

Gateway provider example:

```toml
model_provider = "codex_gateway"

[model_providers.codex_gateway]
name = "OpenAI"
base_url = "http://localhost:8436/v1"
wire_api = "responses"
supports_websockets = true
```

When the listener host is `0.0.0.0`, the generated provider URL still uses `localhost` so the Codex CLI can connect to the local service.

The generated provider enables Responses WebSocket transport. Setting `supports_websockets = false` manually keeps the existing HTTP/SSE Responses, compact, models, image, and Realtime-call HTTP routes available; it only prevents Codex CLI from selecting Responses-over-WebSocket for this provider.

Do not expose the gateway on `0.0.0.0` or another non-loopback address with a blank or default API key. A non-loopback listener makes account-backed model access reachable from the permitted network; generate a random key in Settings and restrict the host firewall first.

## MCP Gateway Control

Codex Gateway can manage an external [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway) process in Streamable HTTP mode.

Default MCP gateway settings:

```text
host: 127.0.0.1
port: 3000
path: /mcp
```

Example command generated by the app:

```bash
mcp-gateway-service --http --config ./config.json --host 127.0.0.1 --port 3000 --path /mcp --json-response
```

Only filled or enabled options are passed. On Windows, stopping the MCP gateway uses process-tree termination so child processes are also stopped.

## Local Data

Default local data paths:

```text
data/codex-gateway.sqlite
data/browser
```

SQLite stores account metadata, encrypted token data handled by the app runtime, quota snapshots, gateway call records, saved session names and notes, runtime logs, and app settings.

Do not commit `data/`, `~/.codex/auth.json`, `~/.codex/config.toml`, or any file containing tokens.

## Development

Run tests:

```bash
npm test
```

Build the renderer:

```bash
npm run build
```

Run both verification steps:

```bash
npm run verify
```

## Packaging

Create an unpacked Windows build:

```bash
npm run pack:unpacked
```

Output:

```text
release/win-unpacked/Codex Gateway.exe
```

## Safety and Terms

This project is for learning and personal local development only. Users must comply with the Terms of Service of the relevant platforms.

The project does not provide or distribute accounts, API keys, accounts-as-a-service, or proxy services. Do not use it for multi-user sharing, commercial resale, bypassing platform limits, or any other activity that violates service terms.

## License

MIT. See [LICENSE](LICENSE).
