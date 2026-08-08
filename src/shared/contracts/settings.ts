export type Settings = Record<string, string>;

export interface RuntimePaths {
  dataDir: string;
  dbPath: string;
}

export interface ServiceStatus {
  running: boolean;
  installed?: boolean;
  url?: string;
  command?: string;
  error?: string;
  activeHttpRequests?: number;
  activeWebSockets?: number;
}
