function writeResponseChunk(res, value, signal) {
  if (res.destroyed || res.writableEnded) return Promise.reject(abortError("client_cancelled", "Client connection closed."));
  if (signal?.aborted) return Promise.reject(signal.reason || abortError("request_aborted", "Request aborted."));
  if (res.write(value)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(abortError("client_cancelled", "Client connection closed during response streaming."));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason || abortError("request_aborted", "Request aborted."));
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function readBody(req, limitBytes, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const declaredLength = Number(req.headers?.["content-length"] || 0);

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      signal?.removeEventListener("abort", onSignalAbort);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const tooLarge = () => {
      const error = new Error(`Request body exceeds the ${limitBytes}-byte gateway limit.`);
      error.statusCode = 413;
      finish(() => {
        req.resume();
        reject(error);
      });
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limitBytes) return tooLarge();
      chunks.push(chunk);
    };
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks, size)));
    const onError = (error) => finish(() => reject(error));
    const onAborted = () => finish(() => reject(abortError("client_cancelled", "Client aborted the request body.")));
    const onSignalAbort = () => finish(() => reject(signal.reason || abortError("request_aborted", "Request aborted.")));

    if (declaredLength > limitBytes) return tooLarge();
    if (signal?.aborted) return onSignalAbort();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
    signal?.addEventListener("abort", onSignalAbort, { once: true });
  });
}

async function readResponseBody(response, limitBytes, signal) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    if (signal?.aborted) throw signal.reason || abortError("request_aborted", "Request aborted.");
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limitBytes - size;
    if (remaining <= 0) {
      await reader.cancel("gateway error body limit reached");
      break;
    }
    const chunk = Buffer.from(value);
    const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    chunks.push(kept);
    size += kept.length;
    if (chunk.length > remaining || size >= limitBytes) {
      await reader.cancel("gateway error body limit reached");
      break;
    }
  }
  return Buffer.concat(chunks, size);
}

function createRequestLifecycle(req, res, activeRequests) {
  const controller = new AbortController();
  activeRequests?.add(controller);
  const cancelClient = () => abortController(controller, "client_cancelled", "Client connection closed.");
  const onResponseClose = () => {
    if (!res.writableEnded) cancelClient();
  };
  req.once("aborted", cancelClient);
  req.once("error", cancelClient);
  res.once("close", onResponseClose);
  return {
    controller,
    signal: controller.signal,
    dispose() {
      req.off("aborted", cancelClient);
      req.off("error", cancelClient);
      res.off("close", onResponseClose);
      activeRequests?.delete(controller);
    }
  };
}

function createLinkedAbortController(parentSignal) {
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal.reason);
  };
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    signal: controller.signal,
    dispose() {
      parentSignal?.removeEventListener("abort", onAbort);
    }
  };
}

function scheduleAbort(controller, timeoutMs, code, message) {
  if (!controller || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return () => {};
  const timer = setTimeout(() => abortController(controller, code, message), timeoutMs);
  return () => clearTimeout(timer);
}

function abortController(controller, code, message) {
  if (!controller?.signal.aborted) controller.abort(abortError(code, message));
}

function abortError(code, message) {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = code;
  return error;
}

function cancellationKind(error, signal) {
  return signal?.reason?.code || error?.code || (error?.name === "AbortError" ? "request_aborted" : "");
}

function cancellationMessage(kind, error) {
  if (kind === "client_cancelled") return "Client cancelled the request.";
  if (kind === "gateway_shutdown") return "Gateway stopped the request during shutdown.";
  if (kind) return String(error?.message || "Upstream request timed out.");
  return String(error?.message || error);
}

module.exports = {
  writeResponseChunk,
  readBody,
  readResponseBody,
  createRequestLifecycle,
  createLinkedAbortController,
  scheduleAbort,
  abortController,
  cancellationKind,
  cancellationMessage
};
