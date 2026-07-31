import { describe, expect, it } from "vitest";
import { saveResponsesApiUpstreamSchema } from "../src/shared/schemas/upstreams";

const modelCatalogJson = JSON.stringify({ models: [{ slug: "provider-model", display_name: "Provider Model" }] });

describe("saveResponsesApiUpstreamSchema", () => {
  it("accepts required model JSON and three per-model prices", () => {
    const value = saveResponsesApiUpstreamSchema.parse({
      name: "Primary API",
      baseUrl: "https://api.example.com/v1",
      apiKey: "secret",
      enabled: true,
      supportsWebSocket: false,
      balanceQueryType: "deepseek",
      modelCatalogJson,
      modelPricing: { "provider-model": { inputPerMillion: 1.25, cachedInputPerMillion: 0.25, outputPerMillion: 2.5 } },
      publicHeaders: { "X-Tenant": "alpha" }
    });
    expect(value.modelCatalogJson).toBe(modelCatalogJson);
    expect(value.modelPricing["provider-model"]?.outputPerMillion).toBe(2.5);
  });

  it("rejects removed capability and discovery fields", () => {
    const result = saveResponsesApiUpstreamSchema.safeParse({
      name: "Invalid API", baseUrl: "https://api.example.com", enabled: true,
      supportsWebSocket: false, balanceQueryType: "none", modelCatalogJson, modelPricing: {},
      modelDiscoveryMode: "openai_models"
    });
    expect(result.success).toBe(false);
  });
});
