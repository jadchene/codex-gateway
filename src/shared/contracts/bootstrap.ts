import type { PublicAccount } from "./accounts";
import type { AppLogPage, RequestLogPage, TokenSummary } from "./logs";
import type { RuntimePaths, ServiceStatus, Settings } from "./settings";

export interface QuotaDetail {
  remaining_percent?: number;
  reset_at?: number;
}

export interface BootstrapData {
  app: {
    version: string;
  };
  settings: Settings;
  accounts: PublicAccount[];
  tokenLogs: RequestLogPage;
  tokenSummary: TokenSummary;
  quotaSummary: { primary?: QuotaDetail; secondary?: QuotaDetail };
  appLogs: AppLogPage;
  gateway: ServiceStatus;
  mcpGateway: ServiceStatus;
  paths: RuntimePaths;
}
