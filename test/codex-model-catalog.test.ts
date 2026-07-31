import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createCodexModelCatalogService } from "../src/main/codex-model-catalog.ts";
import { createStore } from "../src/main/store.ts";
import { BUILTIN_SUBSCRIPTION_ID, createUpstreamService } from "../src/main/upstreams/upstream-service.ts";

const codec = { encrypt: (value: string) => value, decrypt: (value: string) => value, isEncrypted: () => true };
const bundled = JSON.stringify({ models: [{ slug: "gpt-built-in", display_name: "GPT Built In", support_shell_tool: true }] });

test("cached bundled and external channel catalogs merge without rerunning Codex on gateway rebuild", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-"));
  const store = createStore({ secretCodec: codec, dataDir: directory, dbPath: path.join(directory, "test.sqlite") });
  let debugCalls = 0;
  try {
    const upstreams = createUpstreamService({ db: store.db, secretCodec: codec });
    const catalogs = createCodexModelCatalogService({ db: store.db, dataDir: directory, runBundledModels: () => { debugCalls += 1; return bundled; } });
    catalogs.refreshBundled();
    assert.equal(debugCalls, 1);
    upstreams.saveModelPricing(BUILTIN_SUBSCRIPTION_ID, {
      "gpt-built-in": { inputPerMillion: 1.23, cachedInputPerMillion: 0.45, outputPerMillion: 6.78 }
    });
    upstreams.save({
      name: "Third Party", baseUrl: "https://api.example.test/v1", enabled: true,
      supportsWebSocket: false, balanceQueryType: "none",
      modelCatalogJson: JSON.stringify({ models: [{ slug: "third-party-model", display_name: "Third Party" }] }),
      modelPricing: { "third-party-model": { inputPerMillion: 2, cachedInputPerMillion: 1, outputPerMillion: 4 } }
    });
    const result = catalogs.refresh();
    assert.equal(debugCalls, 1);
    assert.equal(result.totalCount, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.path, "utf8")).models.map((model: { slug: string }) => model.slug), ["gpt-built-in", "third-party-model"]);
    catalogs.refreshBundled();
    assert.equal(debugCalls, 2);
    assert.deepEqual(upstreams.getModelPricing(BUILTIN_SUBSCRIPTION_ID, "gpt-built-in"), {
      inputPerMillion: 1.23, cachedInputPerMillion: 0.45, outputPerMillion: 6.78
    });
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy discovered API models are normalized to Codex slugs during catalog rebuild", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-legacy-"));
  const store = createStore({ secretCodec: codec, dataDir: directory, dbPath: path.join(directory, "test.sqlite") });
  try {
    const catalogs = createCodexModelCatalogService({ db: store.db, dataDir: directory, runBundledModels: () => bundled });
    catalogs.refreshBundled();
    const upstreamId = "legacy-api";
    const timestamp = Math.floor(Date.now() / 1000);
    store.db.prepare(`
      INSERT INTO upstreams (
        id, name, kind, enabled, base_url, auth_type, supports_http,
        supports_websocket, capabilities_json, cost_factors_json, created_at, updated_at
      ) VALUES (?, 'Legacy API', 'responses_api', 1, 'https://api.example.test/v1',
        'bearer', 1, 0, '{}', '{}', ?, ?)
    `).run(upstreamId, timestamp, timestamp);
    store.db.prepare(`
      INSERT INTO upstream_models (
        upstream_id, model_id, display_name, available, source,
        capabilities_json, raw_metadata_json, pricing_json, last_seen_at, last_synced_at
      ) VALUES (?, 'legacy-model', 'Legacy Model', 1, 'discovery', '{}',
        '{"id":"legacy-model","object":"model"}', '{}', ?, ?)
    `).run(upstreamId, timestamp, timestamp);

    const result = catalogs.refresh();
    const external = JSON.parse(fs.readFileSync(result.path, "utf8")).models.find((model: { slug: string }) => model.slug === "legacy-model");
    assert.deepEqual(external, {
      id: "legacy-model",
      object: "model",
      slug: "legacy-model",
      display_name: "Legacy Model",
      prefer_websockets: false,
      supports_websockets: false
    });
    const stored = JSON.parse(String(store.db.prepare(`
      SELECT raw_metadata_json FROM upstream_models WHERE upstream_id = ? AND model_id = 'legacy-model'
    `).get(upstreamId)?.raw_metadata_json));
    assert.equal(stored.slug, "legacy-model");
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
