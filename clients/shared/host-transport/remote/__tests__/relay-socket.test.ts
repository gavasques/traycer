import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../../ws-stream-factory";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../../ws-factory";
import { RELAY_PONG_TIMEOUT_MS, RELAY_WAKE_PROBE_TIMEOUT_MS } from "../config";
import { RelaySocket, type RelaySocketHandlers } from "../relay-socket";

// `RelaySocket.pokeKeepalive` runs the keepalive's staleness check off the
// 25s interval schedule - the whole reason `RemoteSession.wake` can detect a
// socket the runtime's frozen interval never got the chance to notice was
// already dead (an OS sleep, a WebView suspended on app switch) - AND, for a
// socket that only LOOKS alive, holds the ping it just sent to a much
// shorter deadline than the scheduled keepalive allows, so a drop that
// happened silently during a short app switch is not mistaken for a live
// connection for the rest of a full minute. These drive the socket directly
// rather than through the full mux/Noise harness in remote-session.test.ts,
// which cannot be run under fake timers without fighting its async
// handshake dance.

class FakeSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sent: (string | Uint8Array)[] = [];

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(_code: number, _reason: string): void {
    // The tests below only exercise `RelaySocket`'s own teardown bookkeeping,
    // never a server-initiated close, so nothing needs to happen here.
  }
}

interface FakeHandlers extends RelaySocketHandlers {
  readonly closeEvents: { code: number; reason: string }[];
}

function buildHandlers(): FakeHandlers {
  const closeEvents: { code: number; reason: string }[] = [];
  return {
    onAttachAck: () => undefined,
    onData: () => undefined,
    onHostDetached: () => undefined,
    onHostAttached: () => undefined,
    onReauthAck: () => undefined,
    onPeerGone: () => undefined,
    onError: () => undefined,
    onClose: (info) => {
      closeEvents.push(info);
    },
    closeEvents,
  };
}

describe("RelaySocket.pokeKeepalive", () => {
  let socket: FakeSocket;
  let factory: IStreamWebSocketFactory;

  beforeEach(() => {
    socket = new FakeSocket();
    factory = { create: () => socket };
  });

  it("is a no-op before the socket has opened", () => {
    const handlers = buildHandlers();
    const relaySocket = new RelaySocket({
      attachBaseUrl: "wss://relay.test/attach",
      grantJws: "grant-jws",
      webSocketFactory: factory,
      handlers,
    });

    relaySocket.pokeKeepalive();

    expect(handlers.closeEvents).toEqual([]);
    expect(socket.sent).toEqual([]);
    relaySocket.close(1000, "test-teardown");
  });

  it("sends a ping and does not close a healthy, open socket", () => {
    const handlers = buildHandlers();
    const relaySocket = new RelaySocket({
      attachBaseUrl: "wss://relay.test/attach",
      grantJws: "grant-jws",
      webSocketFactory: factory,
      handlers,
    });
    socket.onopen?.({ type: "open" });

    relaySocket.pokeKeepalive();

    expect(socket.sent).toEqual(["relay-ping"]);
    expect(handlers.closeEvents).toEqual([]);
    relaySocket.close(1000, "test-teardown");
  });

  it("fails the socket and reports the drop once the pong deadline has passed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // Past the pong deadline with no pong received in between - a socket
      // whose keepalive interval was frozen (device sleep, a suspended
      // WebView) and never got the chance to notice the drop on its own.
      vi.setSystemTime(RELAY_PONG_TIMEOUT_MS + 1);
      relaySocket.pokeKeepalive();

      expect(handlers.closeEvents).toEqual([
        { code: 4004, reason: "relay-missed-pongs" },
      ]);

      // The socket is already failed - a second poke must not report a
      // second drop.
      relaySocket.pokeKeepalive();
      expect(handlers.closeEvents).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op after the socket has closed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });
      relaySocket.close(1000, "caller-teardown");

      vi.setSystemTime(RELAY_PONG_TIMEOUT_MS + 1);
      relaySocket.pokeKeepalive();

      // Caller-initiated `close()` does not itself report a drop, and a poke
      // afterwards must not manufacture one either.
      expect(handlers.closeEvents).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays open when the wake-time probe's ping is answered", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      relaySocket.pokeKeepalive();
      expect(socket.sent).toEqual(["relay-ping"]);
      // The far end answers before the probe deadline.
      socket.onmessage?.({ type: "text", data: "relay-pong" });

      vi.advanceTimersByTime(RELAY_WAKE_PROBE_TIMEOUT_MS + 1);

      expect(handlers.closeEvents).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not close immediately when the wake-time probe goes unanswered, only once its own deadline elapses", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // The far end has gone silent - no pong ever arrives.
      relaySocket.pokeKeepalive();
      expect(handlers.closeEvents).toEqual([]);

      vi.advanceTimersByTime(RELAY_WAKE_PROBE_TIMEOUT_MS - 1);
      expect(handlers.closeEvents).toEqual([]);

      vi.advanceTimersByTime(2);
      expect(handlers.closeEvents).toEqual([
        { code: 4006, reason: "relay-wake-probe-timeout" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms a fresh probe after an earlier one was answered", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // First wake: answered, so this probe is spent.
      relaySocket.pokeKeepalive();
      socket.onmessage?.({ type: "text", data: "relay-pong" });

      // A second wake INSIDE the first probe's original window - an app
      // switched away and back twice in quick succession. The socket died in
      // between, so nothing answers this one. It must arm a probe of its own
      // rather than being swallowed by the answered window, and the earlier
      // pong must not count as its answer.
      vi.advanceTimersByTime(RELAY_WAKE_PROBE_TIMEOUT_MS / 2);
      relaySocket.pokeKeepalive();
      expect(handlers.closeEvents).toEqual([]);

      vi.advanceTimersByTime(RELAY_WAKE_PROBE_TIMEOUT_MS + 1);

      expect(handlers.closeEvents).toEqual([
        { code: 4006, reason: "relay-wake-probe-timeout" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms a single wake-time probe across repeated pokeKeepalive calls, not one per call", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // A burst of pokes - one per subscriber on a single visibility edge.
      // The outstanding probe is already asking this question, so the later
      // pokes send nothing at all: one ping on the wire, not one per caller.
      relaySocket.pokeKeepalive();
      relaySocket.pokeKeepalive();
      relaySocket.pokeKeepalive();
      expect(socket.sent).toEqual(["relay-ping"]);

      vi.advanceTimersByTime(RELAY_WAKE_PROBE_TIMEOUT_MS + 1);

      // One close, not three - a second and third armed probe would each
      // fire their own.
      expect(handlers.closeEvents).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fails immediately on an already-60s-stale socket - the wake probe does not replace that verdict", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      vi.setSystemTime(RELAY_PONG_TIMEOUT_MS + 1);
      relaySocket.pokeKeepalive();

      // The scheduled-check verdict, not the shorter wake-probe one - the
      // socket never got as far as sending a fresh probe ping.
      expect(handlers.closeEvents).toEqual([
        { code: 4004, reason: "relay-missed-pongs" },
      ]);
      expect(handlers.closeEvents.some((event) => event.code === 4006)).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
