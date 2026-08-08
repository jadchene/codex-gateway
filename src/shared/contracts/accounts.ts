export interface ResetCredit {
  id?: string;
  status?: string;
  title?: string;
  granted_at?: number;
  expires_at?: number;
}

export type ResetCreditConsumeStatus = "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit" | "error";

export interface ConsumeResetCreditResult {
  status: ResetCreditConsumeStatus;
  message: string;
  account: PublicAccount;
}

export interface PublicAccount {
  id: string;
  name: string;
  email?: string;
  enabled: boolean;
  status: string;
  priority?: number;
  last_refresh?: string | null;
  subscription_plan?: string;
  subscription_expires_at?: number;
  quota_5h_used_percent?: number;
  quota_5h_reset_at?: number;
  quota_7d_used_percent?: number;
  quota_7d_reset_at?: number;
  reset_credits_available_count?: number;
  reset_credits_next_expires_at?: number;
  reset_credits_json?: string;
  has_access_token: boolean;
  has_refresh_token: boolean;
}

export interface UsageRefreshResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface LoginStartResult {
  loginId: string;
}

export interface LoginStatus {
  status: "pending" | "success" | "failed" | "cancelled" | "unknown";
  error?: string | null;
}
