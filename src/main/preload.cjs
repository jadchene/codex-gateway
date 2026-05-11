const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexGateway", {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  saveAccount: (account) => ipcRenderer.invoke("accounts:save", account),
  setAccountEnabled: (id, enabled) => ipcRenderer.invoke("accounts:setEnabled", id, enabled),
  deleteAccount: (id) => ipcRenderer.invoke("accounts:delete", id),
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  refreshUsage: (id) => ipcRenderer.invoke("accounts:refreshUsage", id),
  refreshAllUsage: () => ipcRenderer.invoke("accounts:refreshAllUsage"),
  importLocalCodexAccount: () => ipcRenderer.invoke("accounts:importLocalCodex"),
  listTokenLogs: (query) => ipcRenderer.invoke("tokens:list", query),
  tokenSummary: (query) => ipcRenderer.invoke("tokens:summary", query),
  quotaSummary: () => ipcRenderer.invoke("quota:summary"),
  clearTokenLogs: () => ipcRenderer.invoke("tokens:clear"),
  listAppLogs: (query) => ipcRenderer.invoke("appLogs:list", query),
  clearAppLogs: () => ipcRenderer.invoke("appLogs:clear"),
  startGateway: () => ipcRenderer.invoke("gateway:start"),
  stopGateway: () => ipcRenderer.invoke("gateway:stop"),
  applyGatewayAuth: () => ipcRenderer.invoke("codexAuth:applyGatewayMode"),
  applyAccountAuth: (accountId) => ipcRenderer.invoke("codexAuth:applyAccountMode", accountId),
  startLogin: () => ipcRenderer.invoke("auth:startLogin"),
  loginStatus: (loginId) => ipcRenderer.invoke("auth:status", loginId),
  openPath: (target) => ipcRenderer.invoke("shell:openPath", target),
  onGatewayStatusChanged: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("gateway:status-changed", listener);
    return () => ipcRenderer.removeListener("gateway:status-changed", listener);
  },
  onDataChanged: (callback) => {
    const listener = (_event, types) => callback(types);
    ipcRenderer.on("app:data-changed", listener);
    return () => ipcRenderer.removeListener("app:data-changed", listener);
  }
});
