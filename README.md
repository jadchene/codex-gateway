# Codex Gateway

[中文文档](README_zh.md)

**Disclaimer**: This project is for learning and local development only. Users must comply with the Terms of Service of the relevant platforms. It is intended for personal local use and does not provide or distribute accounts, API keys, accounts-as-a-service, or proxy services. It must not be used for multi-user sharing, commercial resale, bypassing limits, or any other activity that violates service terms. Use it at your own risk.

Codex Gateway is a local desktop app for managing personal Codex/ChatGPT login state, switching Codex authentication modes, viewing quota information, and running local gateway services. It is built with Electron, React, and Vite. Data is stored locally in SQLite.

## What It Provides

- **Account management**: Add personal accounts through browser OAuth or import an existing local Codex auth file.
- **Quota visibility**: Track 5-hour and 7-day quota windows and refresh usage manually, on a timer, or before gateway failover.
- **Codex auth management**: Switch Codex between local gateway mode and direct account mode by writing `~/.codex/auth.json` and `~/.codex/config.toml`.
- **Codex gateway service**: Expose a local OpenAI-compatible `/v1` gateway for Codex-oriented routes.
- **MCP gateway service control**: Start and stop an external `mcp-gateway-service` in Streamable HTTP mode from the app.
- **Call records**: Store request path, upstream path, account, session ID, duration, status, and token usage.
- **Session management**: Save, name, search, and delete Codex session IDs from call records.
- **Runtime logs**: Review startup, auth writes, gateway events, usage refreshes, and failures.
- **App settings**: Configure ports, API keys, auto-start behavior, close-to-tray behavior, billing factors, and local log cleanup.

## Interface Overview

- **Dashboard**: Shows available account count, Codex gateway status, MCP gateway status, quota summaries, and today's token usage.
- **Accounts**: Adds accounts, enables or disables accounts, refreshes account usage, and imports local Codex credentials.
- **Auth Management**: Applies gateway mode or account mode to the local Codex CLI configuration.
- **Gateway Services**: Controls the built-in Codex gateway and the external MCP gateway service separately.
- **Session Management**: Stores friendly names and notes for Codex session IDs.
- **Call Records**: Queries gateway call logs by date, account, and session ID.
- **Runtime Logs**: Shows local app operation logs.
- **Settings**: Edits gateway, startup, refresh, billing, MCP gateway, and cleanup settings.

## Codex Gateway

The built-in Codex gateway exposes a small local OpenAI-compatible surface for Codex requests:

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`

The gateway forwards requests to the configured upstream Codex backend. It replaces only the upstream `Authorization` and `ChatGPT-Account-ID` headers. Image endpoints are not supported.

The default local gateway settings are:

```text
host: localhost
port: 8436
base URL: http://localhost:8436/v1
API key: local-personal-token
```

The API key and listener settings can be changed in the app.

## Account Usage Model

For each gateway request, the app picks one currently available account. If that account returns an authentication, quota, or rate-limit error, the app refreshes local usage information and tries the next available account for that request.

The app keeps the current account while it remains usable. Once per local day, the first gateway request can rebalance toward an account with more remaining 7-day quota.

This behavior is intended to reduce manual account switching during personal local development. It should not be interpreted as concurrent scheduling, resource pooling, quota aggregation, or a way to bypass service restrictions.

## Codex Auth Integration

The Auth Management page supports two modes:

- **Gateway mode**: writes a local `OPENAI_API_KEY` to `~/.codex/auth.json` and ensures `~/.codex/config.toml` contains a `codex_gateway` provider.
- **Account mode**: writes the selected local account token to `~/.codex/auth.json` and removes the gateway provider written by this app.

Gateway provider example:

```toml
model_provider = "codex_gateway"

[model_providers.codex_gateway]
name = "OpenAI"
base_url = "http://localhost:8436/v1"
wire_api = "responses"
```

When the listener host is `0.0.0.0`, the generated provider URL uses `localhost` so the Codex CLI can connect to the local service.

## MCP Gateway Control

Codex Gateway can manage an external [`mcp-gateway-service`](https://www.npmjs.com/package/@jadchene/mcp-gateway-service) process in Streamable HTTP mode.

Default MCP gateway settings in the app are:

```text
host: 127.0.0.1
port: 3000
path: /mcp
```

The app starts the service with `--http` and adds optional arguments from settings:

```bash
mcp-gateway-service --http --config ./config.json --host 127.0.0.1 --port 3000 --path /mcp --json-response
```

Only filled or enabled options are passed:

- `--config <path>` is included when a config path is set.
- `--host <host>` is included when a host is set.
- `--port <port>` is included when a port is set.
- `--path <path>` is included when a path is set.
- `--json-response` is included only when JSON Response is enabled.

On Windows, stopping the MCP gateway uses process-tree termination so child processes are also stopped.

## Local Data

Default local data paths:

```text
data/codex-gateway.sqlite
data/browser
```

SQLite stores:

- account tokens and account metadata
- quota snapshots
- gateway call records
- saved Codex session names and notes
- runtime logs
- application settings

Do not commit `data/`, `~/.codex/auth.json`, `~/.codex/config.toml`, or any file containing tokens.

## Quick Start

Install dependencies:

```bash
npm install
```

Run the app in development mode:

```bash
npm run dev
```

The Vite development server runs at:

```text
http://127.0.0.1:8435
```

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

Output directory:

```text
release/win-unpacked
```

Windows executable:

```text
release/win-unpacked/Codex Gateway.exe
```

## Notes

- The app is local-first and does not require a hosted backend.
- Close behavior can be set to exit the app or minimize it to the system tray.
- Gateway and usage refresh events are written to local runtime logs.
- Billing factors in settings affect display calculations for local usage summaries only.

## License

MIT
