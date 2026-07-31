import type { PublicAccount, LoginStartResult, LoginStatus, UsageRefreshResult } from "./accounts";
import type { BootstrapData } from "./bootstrap";
import type { AppLogPage, LogQuery, RequestLogPage, TokenSummary } from "./logs";
import type { ServiceStatus, Settings } from "./settings";
import type {
  BalanceRefreshResult,
  ModelPricing,
  SaveResponsesApiUpstreamInput,
  UpstreamHealthResult,
  UpstreamInvocationTestResult,
  UpstreamModel,
  UpstreamSummary
} from "./upstreams";

interface IpcSpec<Args extends unknown[], Result> {
  args: Args;
  result: Result;
}

interface ClearResult { deleted: number }
interface ApplyAuthResult { providerChanged?: boolean; providerRemoved?: boolean }

export type IpcContract = {
  "app:bootstrap": IpcSpec<[], BootstrapData>;
  "settings:save": IpcSpec<[patch: Record<string, unknown>], Settings>;
  "accounts:setEnabled": IpcSpec<[id: string, enabled: boolean], PublicAccount[]>;
  "accounts:delete": IpcSpec<[id: string], PublicAccount[]>;
  "accounts:list": IpcSpec<[], PublicAccount[]>;
  "upstreams:list": IpcSpec<[], UpstreamSummary[]>;
  "upstreams:models": IpcSpec<[upstreamId: string], UpstreamModel[]>;
  "upstreams:save": IpcSpec<[input: SaveResponsesApiUpstreamInput], UpstreamSummary>;
  "upstreams:delete": IpcSpec<[upstreamId: string], { deleted: boolean; id: string }>;
  "upstreams:refreshBalance": IpcSpec<[upstreamId: string], BalanceRefreshResult>;
  "upstreams:refreshBuiltinModels": IpcSpec<[], { path: string; bundledCount: number; externalCount: number; totalCount: number }>;
  "upstreams:saveModelPricing": IpcSpec<[upstreamId: string, pricing: Record<string, ModelPricing>], UpstreamModel[]>;
  "upstreams:testConnection": IpcSpec<[upstreamId: string], UpstreamHealthResult>;
  "upstreams:testInvocation": IpcSpec<[upstreamId: string, modelId: string], UpstreamInvocationTestResult>;
  "tokens:list": IpcSpec<[query: LogQuery], RequestLogPage>;
  "tokens:summary": IpcSpec<[query?: LogQuery], TokenSummary>;
  "quota:summary": IpcSpec<[], BootstrapData["quotaSummary"]>;
  "tokens:clear": IpcSpec<[], ClearResult>;
  "appLogs:list": IpcSpec<[query: LogQuery], AppLogPage>;
  "appLogs:clear": IpcSpec<[], ClearResult>;
  "gateway:start": IpcSpec<[], ServiceStatus>;
  "gateway:stop": IpcSpec<[], ServiceStatus>;
  "mcpGateway:start": IpcSpec<[], ServiceStatus>;
  "mcpGateway:stop": IpcSpec<[], ServiceStatus>;
  "codexAuth:applyGatewayMode": IpcSpec<[], ApplyAuthResult>;
  "codexAuth:applyAccountMode": IpcSpec<[accountId: string], ApplyAuthResult>;
  "auth:startLogin": IpcSpec<[], LoginStartResult>;
  "auth:status": IpcSpec<[loginId: string], LoginStatus>;
  "accounts:refreshUsage": IpcSpec<[id: string], unknown>;
  "accounts:refreshAllUsage": IpcSpec<[], UsageRefreshResult[]>;
  "accounts:importLocalCodex": IpcSpec<[], PublicAccount>;
};

export type IpcChannel = keyof IpcContract;
