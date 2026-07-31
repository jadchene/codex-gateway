import type { CodexGatewayBridge } from "../../preload";

declare global {
  interface Window {
    codexGateway: CodexGatewayBridge;
  }
}

export {};
