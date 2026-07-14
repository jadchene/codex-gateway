const { WebSocket } = require("ws");

/**
 * Relays application messages between independently negotiated WebSockets.
 */
function bridgeWebSockets(options) {
  const {
    downstream,
    upstream,
    controller,
    bufferHighWaterBytes,
    onDownstreamMessage,
    onUpstreamMessage
  } = options;
  let closing = false;

  const forward = (source, destination, observe) => (data, isBinary) => {
    observe?.(data, isBinary);
    if (destination.readyState !== WebSocket.OPEN) return;
    if (destination.bufferedAmount >= bufferHighWaterBytes) source.pause();
    destination.send(data, { binary: isBinary }, (error) => {
      if (source.isPaused && source.isPaused() && destination.bufferedAmount < bufferHighWaterBytes) source.resume();
      if (error) abortController(controller, "websocket_forward_error", error.message);
    });
  };
  downstream.on("message", forward(downstream, upstream, onDownstreamMessage));
  upstream.on("message", forward(upstream, downstream, onUpstreamMessage));

  const closePeer = (peer) => (code, reason) => {
    if (closing) return;
    closing = true;
    if (peer.readyState === WebSocket.OPEN && code === 1005) peer.close();
    else if (peer.readyState === WebSocket.OPEN && isSendableCloseCode(code)) peer.close(code, reason);
    else if (peer.readyState !== WebSocket.CLOSED) peer.terminate();
  };
  downstream.once("close", closePeer(upstream));
  upstream.once("close", closePeer(downstream));
  const terminate = (error) => abortController(controller, "websocket_transport_error", error.message);
  downstream.once("error", terminate);
  upstream.once("error", terminate);
  controller.signal.addEventListener("abort", () => {
    if (downstream.readyState !== WebSocket.CLOSED) downstream.terminate();
    if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
  }, { once: true });
}

function isSendableCloseCode(code) {
  return code === 1000
    || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code))
    || (code >= 3000 && code <= 4999);
}

function abortController(controller, code, message) {
  if (controller.signal.aborted) return;
  const error = new Error(message);
  error.name = "AbortError";
  error.code = code;
  controller.abort(error);
}

module.exports = { bridgeWebSockets };
