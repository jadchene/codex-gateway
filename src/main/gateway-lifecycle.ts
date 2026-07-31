import type { IncomingMessage, ServerResponse } from "node:http";

export function writeResponseChunk(
  res: ServerResponse,
  value: string | Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  if (res.destroyed || res.writableEnded) return Promise.reject(abortError("client_cancelled", "Client connection closed."));
  if (signal?.aborted) return Promise.reject(signal.reason || abortError("request_aborted", "Request aborted."));
  if (res.write(value)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(abortError("client_cancelled", "Client connection closed during response streaming."));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason || abortError("request_aborted", "Request aborted."));
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function readBody(req: IncomingMessage, limitBytes: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const declaredLength = Number(req.headers?.["content-length"] || 0);

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      signal?.removeEventListener("abort", onSignalAbort);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const tooLarge = (): void => {
      const error = Object.assign(new Error(`Request body exceeds the ${limitBytes}-byte gateway limit.`), { statusCode: 413 });
      finish(() => {
        req.resume();
        reject(error);
      });
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limitBytes) return tooLarge();
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(() => resolve(Buffer.concat(chunks, size)));
    const onError = (error: Error): void => finish(() => reject(error));
    const onAborted = (): void => finish(() => reject(abortError("client_cancelled", "Client aborted the request body.")));
    const onSignalAbort = (): void => finish(() => reject(signal?.reason || abortError("request_aborted", "Request aborted.")));

    if (declaredLength > limitBytes) return tooLarge();
    if (signal?.aborted) return onSignalAbort();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
    signal?.addEventListener("abort", onSignalAbort, { once: true });
  });
}

export async function readResponseBody(response: Response, limitBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
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

export function createRequestLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  activeRequests?: Set<AbortController>
): { controller: AbortController; signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  activeRequests?.add(controller);
  const cancelClient = (): void => abortController(controller, "client_cancelled", "Client connection closed.");
  const onResponseClose = (): void => {
    if (!res.writableEnded) cancelClient();
  };
  req.once("aborted", cancelClient);
  req.once("error", cancelClient);
  res.once("close", onResponseClose);
  return {
    controller,
    signal: controller.signal,
    dispose(): void {
      req.off("aborted", cancelClient);
      req.off("error", cancelClient);
      res.off("close", onResponseClose);
      activeRequests?.delete(controller);
    }
  };
}

export function createLinkedAbortController(parentSignal?: AbortSignal): {
  controller: AbortController;
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    signal: controller.signal,
    dispose(): void {
      parentSignal?.removeEventListener("abort", onAbort);
    }
  };
}

export function scheduleAbort(controller: AbortController | null | undefined, timeoutMs: number, code: string, message: string): () => void {
  if (!controller || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return () => {};
  const timer = setTimeout(() => abortController(controller, code, message), timeoutMs);
  return () => clearTimeout(timer);
}

export function abortController(controller: AbortController | null | undefined, code: string, message: string): void {
  if (controller && !controller.signal.aborted) controller.abort(abortError(code, message));
}

function abortError(code: string, message: string): Error & { code: string } {
  const error = new Error(message);
  error.name = "AbortError";
  return Object.assign(error, { code });
}

export function cancellationKind(error: unknown, signal?: AbortSignal): string {
  return errorCode(signal?.reason) || errorCode(error) || (errorName(error) === "AbortError" ? "request_aborted" : "");
}

export function cancellationMessage(kind: string, error: unknown): string {
  if (kind === "client_cancelled") return "Client cancelled the request.";
  if (kind === "gateway_shutdown") return "Gateway stopped the request during shutdown.";
  if (kind) return errorMessage(error) || "Upstream request timed out.";
  return errorMessage(error);
}

const errorCode = (error: unknown): string => error && typeof error === "object" && "code" in error ? String(error.code) : "";
const errorName = (error: unknown): string => error instanceof Error ? error.name : "";
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error ?? "");
