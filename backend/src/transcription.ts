import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { ServiceState } from "./state.js";
import { ApiError, json } from "./errors.js";
import {
  AudioRelay,
  MAX_AUDIO,
  MAX_TRANSCRIPT,
  byteLength,
  type Frame,
  type RelaySocket,
} from "./audio-relay.js";

export { upstreamUrl } from "./audio-relay.js";

function bytes(data: RawData) {
  return Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
}

function nodeSocket(socket: WebSocket, limit: number): RelaySocket {
  return {
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    listen(events) {
      if (events.open) socket.on("open", events.open);
      if (events.error) socket.on("error", events.error);
      if (events.close) socket.on("close", events.close);
      const { message } = events;
      if (message)
        socket.on("message", (data, binary) =>
          message(binary ? bytes(data) : bytes(data).toString("utf8")),
        );
    },
    send(frame: Frame) {
      return new Promise<void>((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error("socket not open"));
          return;
        }
        if (socket.bufferedAmount + byteLength(frame) > limit) {
          reject(new Error("socket output limit"));
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("socket write deadline")),
          500,
        );
        socket.send(frame, (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 500);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close();
      });
    },
    terminate() {
      socket.terminate();
    },
    processed() {},
  };
}

function connectSupplier(url: string, authorization: string) {
  const socket = new WebSocket(url, {
    headers: { Authorization: authorization },
    handshakeTimeout: 10_000,
    perMessageDeflate: false,
    maxPayload: MAX_TRANSCRIPT,
    followRedirects: false,
  });
  return nodeSocket(socket, MAX_AUDIO);
}

function rejectUpgrade(socket: Duplex, error: ApiError) {
  if (socket.destroyed) return;
  const body = json(error);
  socket.end(
    `HTTP/1.1 ${error.status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    () => socket.destroy(),
  );
}

export function attachAudio(server: Server, state: ServiceState) {
  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_AUDIO,
    clientTracking: false,
  });
  const relay = new AudioRelay(state, connectSupplier);
  const upgrades = new Set<Duplex>();
  const upgrade = async (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    socket.on("error", () => {});
    let end: () => void;
    try {
      end = relay.begin();
    } catch (error) {
      rejectUpgrade(socket, error as ApiError);
      return;
    }
    upgrades.add(socket);
    const timer = setTimeout(() => socket.destroy(), 10_000);
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const ticket = await relay.authorize(url, req.headers);
      if (!ticket) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      if (socket.destroyed) return;
      sockets.handleUpgrade(req, socket, head, (client) => {
        end();
        relay.open(ticket, nodeSocket(client, MAX_TRANSCRIPT));
      });
    } catch (error) {
      rejectUpgrade(
        socket,
        error instanceof ApiError
          ? error
          : new ApiError("internal", "audio upgrade failed"),
      );
    } finally {
      clearTimeout(timer);
      upgrades.delete(socket);
      end();
    }
  };
  server.on("upgrade", upgrade);
  return async () => {
    server.off("upgrade", upgrade);
    for (const socket of upgrades) socket.destroy();
    await relay.close();
    sockets.close();
  };
}
