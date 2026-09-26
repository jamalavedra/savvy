import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { ServiceState } from "./state.js";
import { ApiError, json } from "./errors.js";
import { reserveAttempt } from "./billing.js";
import {
  attachSource,
  checkAudio,
  detachSource,
  onAudio,
  onIdleCheck,
  parseSource,
  requireSession,
  settleDisconnectedSource,
  abandonFailedSource,
  sourceGeneration,
  validateSessionId,
  AUDIO_IDLE_MS,
  type Source,
  type SessionRow,
} from "./sessions.js";

const MAX_AUDIO = 32_000;
const MAX_TRANSCRIPT = 1_048_576;
const LANGUAGES = new Set([
  "multi",
  "en",
  "es",
  "ca",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "da",
  "sv",
  "no",
  "fi",
  "pl",
  "tr",
  "ja",
  "ko",
  "zh",
  "hi",
  "id",
  "ru",
  "uk",
  "el",
  "cs",
  "ro",
  "hu",
  "bg",
  "vi",
  "th",
]);
export function upstreamUrl(base: string, language: string) {
  const url = new URL(base);
  url.search = new URLSearchParams({
    model: "nova-3",
    language: LANGUAGES.has(language) ? language : "multi",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
    mip_opt_out: "true",
  }).toString();
  return url.toString();
}
function bytes(data: RawData) {
  return Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
}
function send(socket: WebSocket, data: Buffer | string, limit: number) {
  return new Promise<void>((resolve, reject) => {
    if (
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount + Buffer.byteLength(data) > limit
    ) {
      reject(new Error("socket output unavailable"));
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("socket write deadline")),
      500,
    );
    socket.send(data, (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}
function close(socket: WebSocket) {
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
  const active = new Map<WebSocket, Promise<void>>();
  const sourceSlots = new Map<string, Promise<void>>();
  const upgrades = new Set<Duplex>();
  let closing = false;
  const upgrade = async (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    // ponytail: one-process ceiling of 128 audio sockets; raise only after load checks.
    if (upgrades.size + active.size >= 128) {
      socket.on("error", () => {});
      rejectUpgrade(
        socket,
        new ApiError(
          "rate_limited",
          "audio connection capacity reached",
          1000n,
        ),
      );
      return;
    }
    upgrades.add(socket);
    socket.on("error", () => {});
    const timer = setTimeout(() => socket.destroy(), 10_000);
    try {
      if (closing)
        throw new ApiError(
          "provider_unavailable",
          "managed service is draining",
        );
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = /^\/v1\/sessions\/([^/]+)\/audio\/([^/]+)$/.exec(
        url.pathname,
      );
      if (!path) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      const account = await state.authorize(req.headers);
      state.requireAssistance();
      let id: string, source: Source;
      try {
        id = validateSessionId(decodeURIComponent(path[1]));
        source = parseSource(decodeURIComponent(path[2]));
      } catch (error) {
        throw error instanceof ApiError
          ? error
          : new ApiError("invalid_request", "invalid audio path");
      }
      const version = url.searchParams.get("leaseVersion") ?? "0";
      if (
        !/^[+-]?\d+$/.test(version) ||
        url.searchParams.getAll("leaseVersion").length > 1 ||
        url.searchParams.getAll("language").length > 1
      )
        throw new ApiError("invalid_request", "invalid audio query");
      const session = requireSession(state.db, account.accountId, id);
      if (session.state !== "active")
        throw new ApiError(
          "session_conflict",
          "this meeting session is not accepting audio",
        );
      if (
        BigInt(version) !== session.lease_version ||
        session.lease_expires_ms === null ||
        session.lease_expires_ms <= state.clock()
      )
        throw new ApiError("session_conflict", "expired or stale lease");
      if (closing || socket.destroyed) return;
      state.db
        .transaction(() => {
          const now = state.clock();
          reserveAttempt(
            state.db,
            account.accountId,
            "audio_connect",
            now,
            60_000n,
            12n,
          );
          reserveAttempt(
            state.db,
            account.accountId,
            "audio_connect",
            now,
            3_600_000n,
            120n,
          );
          reserveAttempt(
            state.db,
            0n,
            "audio_connect_global",
            now,
            60_000n,
            240n,
          );
        })
        .immediate();
      sockets.handleUpgrade(req, socket, head, (client) => {
        const generation = attachSource(state, session, source, state.clock());
        const key = `${session.id}:${source}`;
        const previous = sourceSlots.get(key);
        const done = relay(
          state,
          client,
          session,
          source,
          generation,
          account.expiresAtMs,
          url.searchParams.get("language") ?? "multi",
          previous,
        );
        active.set(client, done);
        sourceSlots.set(key, done);
        void done.finally(() => {
          active.delete(client);
          if (sourceSlots.get(key) === done) sourceSlots.delete(key);
        });
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
    }
  };
  server.on("upgrade", upgrade);
  return async () => {
    closing = true;
    server.off("upgrade", upgrade);
    for (const socket of upgrades) socket.destroy();
    for (const client of active.keys()) client.terminate();
    await Promise.all(active.values());
    sockets.close();
  };
}

async function relay(
  state: ServiceState,
  client: WebSocket,
  session: SessionRow,
  source: Source,
  generation: bigint,
  tokenExpiry: bigint,
  language: string,
  previous?: Promise<void>,
) {
  let upstream: WebSocket | undefined;
  let upstreamOpened = false;
  let stopping = false,
    supplierFailure = false,
    pumping = false;
  let queuedBytes = 0,
    outputBytes = 0;
  let lastDelivered = state.clock();
  let pumpTask = Promise.resolve();
  const queue: Buffer[] = [];
  const writes = new Set<Promise<void>>();
  let finishResolve!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishResolve = resolve;
  });
  const valid = () => {
    const current = requireSession(
      state.db,
      session.account_id,
      session.local_session_id,
    );
    return (
      current.state === "active" &&
      current.lease_version === session.lease_version &&
      current.lease_expires_ms !== null &&
      current.lease_expires_ms > state.clock() &&
      sourceGeneration(state, session.id, source) === generation
    );
  };
  const finish = async (providerFailed = false) => {
    supplierFailure ||= providerFailed;
    if (stopping) return;
    stopping = true;
    clearInterval(monitor);
    queue.length = 0;
    let abandoned = false;
    if (supplierFailure) {
      try {
        abandonFailedSource(
          state,
          session.account_id,
          session.local_session_id,
          source,
          generation,
        );
        abandoned = true;
      } catch {
        /* Retry after the pending write settles. */
      }
    }
    if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate();
    await pumpTask.catch(() => {});
    await Promise.allSettled(writes);
    try {
      if (supplierFailure && !abandoned)
        abandonFailedSource(
          state,
          session.account_id,
          session.local_session_id,
          source,
          generation,
        );
      else if (!supplierFailure)
        settleDisconnectedSource(
          state,
          session.account_id,
          session.local_session_id,
          source,
          generation,
        );
    } catch {
      /* Ledger recovery releases any unsettled reservation on lease expiry. */
    }
    detachSource(state, session.id, source, generation);
    if (upstream?.readyState === WebSocket.OPEN)
      await send(upstream, '{"type":"CloseStream"}', MAX_AUDIO).catch(() => {});
    await Promise.all([close(client), ...(upstream ? [close(upstream)] : [])]);
    finishResolve();
  };
  const pump = async () => {
    if (pumping || stopping || upstream?.readyState !== WebSocket.OPEN) return;
    pumping = true;
    try {
      while (queue.length && !stopping) {
        const chunk = queue.shift()!;
        state.requireAssistance();
        if (state.clock() >= tokenExpiry || !valid()) break;
        checkAudio(
          state,
          session.id,
          source,
          generation,
          chunk.length,
          state.clock(),
        );
        try {
          await send(upstream, chunk, MAX_AUDIO);
        } catch {
          supplierFailure = true;
          throw new ApiError(
            "provider_unavailable",
            "transcription write stalled",
          );
        }
        if (stopping && supplierFailure) break;
        queuedBytes -= chunk.length;
        const outcome = onAudio(
          state,
          session.account_id,
          session.local_session_id,
          source,
          chunk.length,
          state.clock(),
          { version: session.lease_version, generation },
        );
        lastDelivered = state.clock();
        if (outcome === "exhausted") {
          await send(
            client,
            '{"type":"SavvyControl","reason":"quota_exhausted"}',
            MAX_TRANSCRIPT,
          ).catch(() => {});
          break;
        }
      }
      if (!stopping && (!valid() || state.clock() >= tokenExpiry))
        void finish();
    } finally {
      pumping = false;
    }
  };
  const startPump = () => {
    if (!pumping && !stopping) {
      pumpTask = pump();
      void pumpTask.catch(() => finish(supplierFailure));
    }
  };
  client.on("message", (data, binary) => {
    if (stopping || !binary) return;
    const chunk = bytes(data);
    if (
      !chunk.length ||
      chunk.length % 2 ||
      chunk.length > MAX_AUDIO ||
      queuedBytes + chunk.length > MAX_AUDIO
    ) {
      void finish();
      return;
    }
    queuedBytes += chunk.length;
    queue.push(chunk);
    startPump();
  });
  client.on("close", () => {
    void finish();
  });
  client.on("error", () => {
    void finish();
  });
  const monitor = setInterval(() => {
    if (stopping) return;
    try {
      const now = state.clock();
      const disabled = state.db
        .prepare<[bigint], { disabled: bigint }>(
          "SELECT disabled FROM accounts WHERE id=?",
        )
        .get(session.account_id)?.disabled;
      if (
        state.draining ||
        state.aiPaused ||
        now >= tokenExpiry ||
        !valid() ||
        disabled === undefined ||
        disabled !== 0n ||
        (upstream?.readyState === WebSocket.OPEN &&
          now - lastDelivered >= AUDIO_IDLE_MS)
      ) {
        void finish();
        return;
      }
      if (upstream?.readyState === WebSocket.OPEN)
        onIdleCheck(state, session.account_id, session.local_session_id, now);
    } catch {
      void finish();
    }
  }, 100);
  try {
    if (previous) {
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          previous,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("previous source is closing")),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
    }
    if (stopping || !valid()) {
      void finish();
      return await finished;
    }
    upstream = new WebSocket(upstreamUrl(state.config.deepgramUrl, language), {
      headers: { Authorization: `Token ${state.config.deepgramKey}` },
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
      maxPayload: MAX_TRANSCRIPT,
      followRedirects: false,
    });
    upstream.on("open", () => {
      upstreamOpened = true;
    });
    upstream.on("error", () => {
      if (!stopping && upstreamOpened) {
        supplierFailure = true;
        void finish(true);
      }
    });
    upstream.on("close", () => {
      if (!stopping && upstreamOpened) void finish(true);
    });
    upstream.on("message", (data, binary) => {
      if (stopping || binary) return;
      let value;
      try {
        value = JSON.parse(bytes(data).toString("utf8"));
      } catch {
        return;
      }
      if (value?.type !== "Results") return;
      const alternative = value.channel?.alternatives?.[0];
      const filtered = JSON.stringify({
        type: "Results",
        start: value.start ?? null,
        duration: value.duration ?? null,
        is_final: value.is_final ?? null,
        speech_final: value.speech_final ?? null,
        channel: {
          alternatives: [
            {
              transcript: alternative?.transcript ?? null,
              confidence: alternative?.confidence ?? null,
            },
          ],
        },
      });
      const size = Buffer.byteLength(filtered);
      if (outputBytes + size > MAX_TRANSCRIPT) {
        void finish();
        return;
      }
      outputBytes += size;
      const write = send(client, filtered, MAX_TRANSCRIPT);
      writes.add(write);
      void write
        .catch(() => finish())
        .finally(() => {
          outputBytes -= size;
          writes.delete(write);
        });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        upstream!.once("open", resolve);
        upstream!.once("error", reject);
        upstream!.once("close", () =>
          reject(new Error("supplier closed during handshake")),
        );
      });
    } catch {
      supplierFailure = !stopping || supplierFailure;
      if (supplierFailure)
        await send(
          client,
          '{"type":"SavvyControl","reason":"provider_unavailable"}',
          MAX_TRANSCRIPT,
        ).catch(() => {});
      void finish(supplierFailure);
      return await finished;
    }
    if (stopping) return await finished;
    lastDelivered = state.clock();
    startPump();
    return await finished;
  } catch {
    void finish(supplierFailure);
    return await finished;
  }
}
