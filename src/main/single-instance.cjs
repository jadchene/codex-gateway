const crypto = require("node:crypto");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

function singleInstanceEndpoint(options = {}) {
  const identity = String(options.userIdentity || `${os.homedir()}\0${os.userInfo().username}`);
  const suffix = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
  if ((options.platform || process.platform) === "win32") return `\\\\.\\pipe\\codex-gateway-${suffix}`;
  return path.join(options.tempDir || os.tmpdir(), `codex-gateway-${suffix}.sock`);
}

function acquireSingleInstanceChannel(options = {}) {
  const endpoint = options.endpoint || singleInstanceEndpoint(options);
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.resume();
    options.onSecondInstance?.();
    socket.end();
  });
  return new Promise((resolve, reject) => {
    const onListenError = (error) => {
      if (error?.code !== "EADDRINUSE") {
        reject(error);
        return;
      }
      notifyExistingInstance(endpoint, options.connectTimeoutMs).finally(() => {
        resolve({ primary: false, endpoint, server: null });
      });
    };
    server.once("error", onListenError);
    server.listen(endpoint, () => {
      server.off("error", onListenError);
      server.on("error", (error) => options.onError?.(error));
      resolve({ primary: true, endpoint, server });
    });
  });
}

function notifyExistingInstance(endpoint, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!connected && !socket.destroyed) socket.destroy();
      resolve(connected);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      socket.end("show", () => finish(true));
    });
    socket.once("error", () => finish(false));
  });
}

function closeSingleInstanceChannel(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

module.exports = {
  acquireSingleInstanceChannel,
  closeSingleInstanceChannel,
  singleInstanceEndpoint
};
