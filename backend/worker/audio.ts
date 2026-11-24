import {
  AUDIO_PATH,
  AudioRelay,
  CLOSED,
  CONNECTING,
  MAX_QUEUED_AUDIO,
  MAX_TRANSCRIPT,
  OPEN,
  byteLength,
  type Frame,
  type RelaySocket,
  type SocketEvents,
} from "../src/audio-relay.ts";
import { ApiError, json } from "../src/errors.ts";
import type { ServiceState } from "../src/state.ts";

const HANDSHAKE_MS = 10_000;

/**
 * A Workers WebSocket behind the relay's socket contract. Workers expose no
 * `bufferedAmount` or send callback, so a supplier socket counts the audio
 * bytes it sent against the bytes the supplier reports as transcribed, and
 * fails a send once that backlog passes `limit`. An abrupt drop surfaces as close code 1006, as it does on `ws`.
 */
class WorkersSocket implements RelaySocket {
  #ws: WebSocket | undefined;
  #events: Partial<SocketEvents> = {};
  #closed = false;
  #waiters: (() => void)[] = [];
  #sent = 0;
  #processed = 0;
  abort: AbortController | undefined;

  constructor(
    readonly limit: number,
    readonly tracksBacklog: boolean,
  ) {}

  get readyState() {
    if (this.#closed) return CLOSED;
    return this.#ws?.readyState ?? CONNECTING;
  }

  get bufferedAmount() {
    return this.tracksBacklog ? this.#backlog() : null;
  }

  #backlog() {
    return Math.max(0, this.#sent - this.#processed);
  }

  attach(ws: WebSocket) {
    ws.accept();
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.addEventListener("message", (event) =>
      this.#events.message?.(
        typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data as ArrayBuffer),
      ),
    );
    ws.addEventListener("close", (event) =>
      this.ended(event.wasClean ? event.code : 1006),
    );
    ws.addEventListener("error", () => this.ended(1006));
  }

  opened() {
    if (!this.#closed) this.#events.open?.();
  }

  ended(code: number) {
    if (this.#closed) return;
    this.#closed = true;
    this.#events.close?.(code);
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  listen(events: Partial<SocketEvents>) {
    this.#events = events;
  }

  async send(frame: Frame) {
    if (this.readyState !== OPEN) throw new Error("socket not open");
    const backlog = this.#backlog();
    if (backlog + byteLength(frame) > this.limit)
      throw new Error("socket output limit");
    this.#ws!.send(frame);
    if (!this.tracksBacklog || typeof frame === "string") return;
    this.#sent += frame.length;
  }

  processed(bytes: number) {
    this.#processed = Math.max(this.#processed, bytes);
  }

  async close() {
    if (this.#closed) return;
    if (!this.#ws) {
      this.terminate();
      return;
    }
    const closed = new Promise<void>((resolve) => this.#waiters.push(resolve));
    const timer = setTimeout(() => this.terminate(), 500);
    try {
      this.#ws.close();
    } catch {
      this.terminate();
    }
    await closed;
    clearTimeout(timer);
  }

  terminate() {
    this.abort?.abort();
    try {
      this.#ws?.close(1011);
    } catch {
      /* Already closing: the local close below still ends the relay. */
    }
    this.ended(1006);
  }
}

export type SupplierFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

function connectSupplier(
  supplierFetch: SupplierFetch,
  url: string,
  authorization: string,
) {
  const socket = new WorkersSocket(MAX_QUEUED_AUDIO, true);
  socket.abort = new AbortController();
  const handshake = setTimeout(() => socket.abort?.abort(), HANDSHAKE_MS);
  void supplierFetch(url.replace(/^ws/, "http"), {
    headers: { Upgrade: "websocket", Authorization: authorization },
    redirect: "manual",
    signal: socket.abort.signal,
  })
    .then((response) => {
      if (!response.webSocket)
        throw new Error(`supplier answered ${response.status}`);
      socket.attach(response.webSocket);
      if (socket.readyState === CLOSED) response.webSocket.close(1011);
      else socket.opened();
    })
    .catch(() => socket.ended(1006))
    .finally(() => clearTimeout(handshake));
  return socket;
}

function rejection(error: unknown) {
  const failure =
    error instanceof ApiError
      ? error
      : new ApiError("internal", "audio upgrade failed");
  return new Response(json(failure), {
    status: failure.status,
    headers: { "content-type": "application/json" },
  });
}

export function isAudioUpgrade(request: Request) {
  return (
    request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    AUDIO_PATH.test(new URL(request.url).pathname)
  );
}

export function createAudio(state: ServiceState, supplierFetch: SupplierFetch) {
  const relay = new AudioRelay(state, (url, authorization) =>
    connectSupplier(supplierFetch, url, authorization),
  );
  return async (request: Request) => {
    let end: () => void;
    try {
      end = relay.begin();
    } catch (error) {
      return rejection(error);
    }
    try {
      const ticket = await relay.authorize(
        new URL(request.url),
        Object.fromEntries(request.headers),
      );
      if (!ticket) return new Response(null, { status: 404 });
      const [client, server] = Object.values(new WebSocketPair());
      const socket = new WorkersSocket(MAX_TRANSCRIPT, false);
      socket.attach(server!);
      relay.open(ticket, socket);
      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      return rejection(error);
    } finally {
      end();
    }
  };
}
