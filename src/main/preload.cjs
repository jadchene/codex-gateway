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
  listTokenLogs: (query) => ipcRenderer.invoke("tokens:list", query),
  tokenSummary: (query) => ipcRenderer.invoke("tokens:summary", query),
  listAppLogs: (query) => ipcRenderer.invoke("appLogs:list", query),
  startGateway: () => ipcRenderer.invoke("gateway:start"),
  stopGateway: () => ipcRenderer.invoke("gateway:stop"),
  applyGatewayAuth: () => ipcRenderer.invoke("codexAuth:applyGatewayMode"),
  applyAccountAuth: (accountId) => ipcRenderer.invoke("codexAuth:applyAccountMode", accountId),
  startLogin: () => ipcRenderer.invoke("auth:startLogin"),
  loginStatus: (loginId) => ipcRenderer.invoke("auth:status", loginId),
  openPath: (target) => ipcRenderer.invoke("shell:openPath", target)
});
