import { describe, expect, it } from "vitest";
import { estimateUpstreamCost } from "../src/main/upstreams/cost-estimator";

describe("estimateUpstreamCost", () => {
  it("uses three per-model rates and the global currency", () => {
    expect(estimateUpstreamCost(
      { input_tokens: 1_000_000, cached_input_tokens: 250_000, output_tokens: 100_000 },
      { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 10 },
      "CNY"
    )).toEqual({ amount: 2.625, unit: "CNY" });
  });

  it("allows zero-priced models", () => {
    expect(estimateUpstreamCost(
      { input_tokens: 100, output_tokens: 100 },
      { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
      "USD"
    )).toEqual({ amount: 0, unit: "USD" });
  });
});
