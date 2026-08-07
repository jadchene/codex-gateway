import { z } from "zod";

const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "只支持 HTTP 或 HTTPS 地址");

const headerMap = z.record(z.string().trim().min(1).max(128), z.string().max(4096));
const modelPricing = z.object({
  inputPerMillion: z.number().finite().nonnegative().max(1_000_000),
  cachedInputPerMillion: z.number().finite().nonnegative().max(1_000_000),
  outputPerMillion: z.number().finite().nonnegative().max(1_000_000)
}).strict();

export const saveResponsesApiUpstreamSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  baseUrl: httpUrl,
  apiKey: z.string().trim().min(1).optional(),
  enabled: z.boolean(),
  supportsWebSocket: z.boolean(),
  compactAdaptEnabled: z.boolean().optional(),
  balanceQueryType: z.enum(["none", "deepseek"]),
  publicHeaders: headerMap.optional(),
  secretHeaders: headerMap.optional(),
  modelCatalogJson: z.string().trim().min(2).max(4 * 1024 * 1024),
  modelPricing: z.record(z.string().trim().min(1).max(200), modelPricing)
}).strict();

export type SaveResponsesApiUpstream = z.infer<typeof saveResponsesApiUpstreamSchema>;
