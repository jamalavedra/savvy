import { assertFunding, fundingForRow } from "./funding.js";
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
// A network stall shorter than the idle timeout can bunch up paced audio.
const MAX_QUEUED_AUDIO = Number(AUDIO_IDLE_MS) * 32;
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
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("socket not open"));
      return;
    }
    if (socket.bufferedAmount + Buffer.byteLength(data) > limit) {
      reject(new Error("socket output limit"));
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
      assertFunding(
        state.db,
        account.accountId,
        fundingForRow(state.db, account.accountId, session),
        state.clock(),
      );
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
  let clientCloseCode: number | null = null;
  let supplierCloseCode: number | null = null;
  let lastDelivered = state.clock();
  let lastReceived: bigint | null = null;
  let receivedBytes = 0;
  let deliveredBytes = 0;
  let upstreamWriteFailure: string | null = null;
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
  const finish = async (reason: string, providerFailed = false) => {
    supplierFailure ||= providerFailed;
    if (stopping) return;
    stopping = true;
    // Log only transport metadata: supplier errors and close text can contain user data.
    console.info(
      JSON.stringify({
        event: "audio_closed",
        source,
        reason,
        sessionId: session.local_session_id,
        supplierFailure,
        lastDeliveredAgeMs: Number(state.clock() - lastDelivered),
        lastReceivedAgeMs:
          lastReceived === null ? null : Number(state.clock() - lastReceived),
        receivedBytes,
        deliveredBytes,
        tokenRemainingMs: Number(tokenExpiry - state.clock()),
        queuedBytes,
        outputBytes,
        clientCloseCode,
        supplierCloseCode,
        clientState: client.readyState,
        upstreamState: upstream?.readyState ?? null,
        upstreamBufferedBytes: upstream?.bufferedAmount ?? null,
        upstreamWriteFailure,
      }),
    );
    if (supplierFailure) console.warn("transcription provider unavailable");
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
          reason === "client_closed" && clientCloseCode === 1006,
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
  let nextDelivery: number | undefined;
  const pump = async () => {
    if (pumping || stopping || upstream?.readyState !== WebSocket.OPEN) return;
    pumping = true;
    try {
      while (queue.length && !stopping) {
        const chunk = queue.shift()!;
        // Network buffering can bunch up correctly paced client frames.
        nextDelivery ??= performance.now();
        const delay = Math.ceil(nextDelivery - performance.now());
        if (delay > 0)
          await new Promise((resolve) => setTimeout(resolve, delay));
        if (stopping) break;
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
          nextDelivery =
            // Recover late timers within the existing one-second admission burst.
            Math.max(
              nextDelivery,
              performance.now() - (MAX_AUDIO - chunk.length) / 32,
            ) +
            chunk.length / 32;
          await send(upstream, chunk, MAX_AUDIO);
        } catch (error) {
          upstreamWriteFailure =
            error instanceof Error &&
            [
              "socket not open",
              "socket output limit",
              "socket write deadline",
            ].includes(error.message)
              ? error.message
              : "socket write callback";
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
        deliveredBytes += chunk.length;
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
        void finish("lease_or_token_expired");
    } finally {
      pumping = false;
    }
  };
  const startPump = () => {
    if (!pumping && !stopping) {
      pumpTask = pump();
      void pumpTask.catch((error) =>
        finish(
          error instanceof ApiError ? `pump_${error.code}` : "pump_failed",
          supplierFailure,
        ),
      );
    }
  };
  let refreshing = false;
  let lastRefresh = state.clock() - 5000n;
  client.on("message", (data, binary) => {
    if (stopping) return;
    if (!binary) {
      if (
        refreshing ||
        state.clock() - lastRefresh < 5000n ||
        bytes(data).length > 8192
      ) {
        void finish("invalid_auth_frame");
        return;
      }
      lastRefresh = state.clock();
      refreshing = true;
      void (async () => {
        try {
          const message = JSON.parse(bytes(data).toString());
          if (message.type !== "SavvyAuth" || typeof message.token !== "string")
            throw new Error("invalid audio authorization");
          const identity = await state.authorize({
            authorization: `Bearer ${message.token}`,
          });
          if (
            stopping ||
            identity.accountId !== session.account_id ||
            identity.expiresAtMs <= state.clock() ||
            !valid()
          )
            throw new Error("invalid audio authorization");
          tokenExpiry = identity.expiresAtMs;
          await send(client, '{"type":"SavvyAuthOk"}', MAX_TRANSCRIPT);
        } catch {
          await send(
            client,
            '{"type":"SavvyControl","reason":"sign_in_required"}',
            MAX_TRANSCRIPT,
          ).catch(() => {});
          void finish("authorization_failed");
        } finally {
          refreshing = false;
        }
      })();
      return;
    }
    const chunk = bytes(data);
    if (
      !chunk.length ||
      chunk.length % 2 ||
      chunk.length > MAX_AUDIO ||
      queuedBytes + chunk.length >
        (upstreamOpened ? MAX_QUEUED_AUDIO : MAX_AUDIO)
    ) {
      void finish("invalid_or_overflowing_audio");
      return;
    }
    queuedBytes += chunk.length;
    receivedBytes += chunk.length;
    lastReceived = state.clock();
    queue.push(chunk);
    startPump();
  });
  client.on("close", (code) => {
    clientCloseCode = code;
    void finish("client_closed");
  });
  client.on("error", () => {
    void finish("client_error");
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
      let reason: string | undefined;
      if (state.draining) reason = "service_draining";
      else if (state.aiPaused) reason = "assistance_paused";
      else if (now >= tokenExpiry) reason = "token_expired";
      else if (!valid()) reason = "lease_invalid";
      else if (disabled === undefined || disabled !== 0n)
        reason = "account_disabled";
      else if (
        upstream?.readyState === WebSocket.OPEN &&
        now - lastDelivered >= AUDIO_IDLE_MS
      )
        reason = "audio_idle";
      if (reason) {
        void finish(reason);
        return;
      }
      if (upstream?.readyState === WebSocket.OPEN)
        onIdleCheck(state, session.account_id, session.local_session_id, now);
    } catch {
      void finish("monitor_failed");
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
      void finish("lease_invalid_before_supplier");
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
        void finish("supplier_error", true);
      }
    });
    upstream.on("close", (code) => {
      supplierCloseCode = code;
      if (!stopping && upstreamOpened) void finish("supplier_closed", true);
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
        void finish("transcript_overflow");
        return;
      }
      outputBytes += size;
      const write = send(client, filtered, MAX_TRANSCRIPT);
      writes.add(write);
      void write
        .catch(() => finish("transcript_write_failed"))
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
      void finish("supplier_handshake_failed", supplierFailure);
      return await finished;
    }
    if (stopping) return await finished;
    lastDelivered = state.clock();
    startPump();
    return await finished;
  } catch {
    void finish("relay_setup_failed", supplierFailure);
    return await finished;
  }
}
