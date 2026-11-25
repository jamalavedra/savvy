import { assertFunding, fundingForRow } from "./funding.js";
import type { ServiceState } from "./state.js";
import { ApiError } from "./errors.js";
import { noteError } from "./recent-errors.js";
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

export const MAX_AUDIO = 32_000;
// A network stall shorter than the idle timeout can bunch up paced audio.
export const MAX_QUEUED_AUDIO = Number(AUDIO_IDLE_MS) * 32;
export const MAX_TRANSCRIPT = 1_048_576;
export const AUDIO_PATH = /^\/v1\/sessions\/([^/]+)\/audio\/([^/]+)$/;
export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSED = 3;
// ponytail: one-process ceiling of 128 audio sockets; raise only after load checks.
const MAX_SOCKETS = 128;
const MONITOR_MS = 100;
// A blocked object (an open storage transaction) runs no timers and receives no
// frames. A block long enough to trip the idle cutoff is not the client going
// idle, and the audio sent meanwhile is dropped unbilled, since pacing cannot
// catch it up. A shorter block is delivered late.
const FREEZE_MS = Number(AUDIO_IDLE_MS) - 1000;
const THAW_MS = 500;

/** A text frame arrives as a string, a binary frame as bytes. */
export type Frame = string | Uint8Array;

export interface SocketEvents {
  open(): void;
  message(frame: Frame): void;
  /** 1006 means the peer vanished without a close handshake. */
  close(code: number): void;
  error(): void;
}

/**
 * One end of the relay, on `ws` in Node or on a Workers WebSocket. `send`
 * rejects with `socket not open`, `socket output limit` or
 * `socket write deadline` when the peer cannot keep up; any other rejection
 * is reported as a failed write callback.
 */
export interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number | null;
  listen(events: Partial<SocketEvents>): void;
  send(frame: Frame): Promise<void>;
  close(): Promise<void>;
  terminate(): void;
  /** Supplier progress: total audio bytes the supplier has transcribed. */
  processed(bytes: number): void;
}

export type ConnectSupplier = (
  url: string,
  authorization: string,
) => RelaySocket;

export interface AudioTicket {
  session: SessionRow;
  source: Source;
  tokenExpiry: bigint;
  language: string;
}

type Admit = (run: () => bigint | undefined) => Promise<bigint | undefined>;

const LANGUAGES = new Set(
  "multi en es ca fr de it pt nl da sv no fi pl tr ja ko zh hi id ru uk el cs ro hu bg vi th".split(
    " ",
  ),
);
const SEND_FAILURES = [
  "socket not open",
  "socket output limit",
  "socket write deadline",
];
const encoder = new TextEncoder();
export const byteLength = (frame: Frame) =>
  typeof frame === "string" ? encoder.encode(frame).length : frame.length;

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

function batchAdmissions(state: ServiceState): Admit {
  const admissions: {
    run: () => bigint | undefined;
    resolve: (value: bigint | undefined) => void;
    reject: (error: unknown) => void;
  }[] = [];
  return (run) =>
    new Promise<bigint | undefined>((resolve, reject) => {
      admissions.push({ run, resolve, reject });
      if (admissions.length !== 1) return;
      setImmediate(() => {
        const batch = admissions.splice(0);
        const complete: (() => void)[] = [];
        try {
          // Each check keeps its savepoint; release frames only after one durable commit.
          state.db
            .transaction(() => {
              for (const request of batch) {
                try {
                  const value = request.run();
                  complete.push(() => request.resolve(value));
                } catch (error) {
                  complete.push(() => request.reject(error));
                }
              }
            })
            .immediate();
        } catch (error) {
          for (const request of batch) request.reject(error);
          return;
        }
        for (const finish of complete) finish();
      });
    });
}

function reserveConnect(state: ServiceState, accountId: bigint) {
  state.db
    .transaction(() => {
      const now = state.clock();
      reserveAttempt(state.db, accountId, "audio_connect", now, 60_000n, 12n);
      reserveAttempt(
        state.db,
        accountId,
        "audio_connect",
        now,
        3_600_000n,
        120n,
      );
      reserveAttempt(state.db, 0n, "audio_connect_global", now, 60_000n, 240n);
    })
    .immediate();
}

/**
 * Upgrade admission and the live relays of one backend process. A runtime
 * adapter counts each upgrade with `begin`, asks `authorize` for a ticket,
 * accepts its socket and hands both to `open`.
 */
export class AudioRelay {
  #active = new Map<RelaySocket, Promise<void>>();
  #slots = new Map<string, Promise<void>>();
  #pending = 0;
  #closing = false;
  #admit: Admit;

  constructor(
    readonly state: ServiceState,
    readonly connectSupplier: ConnectSupplier,
  ) {
    this.#admit = batchAdmissions(state);
  }

  /** Counts one upgrade in flight, or throws when the ceiling is reached. */
  begin() {
    if (this.#pending + this.#active.size >= MAX_SOCKETS)
      throw new ApiError(
        "rate_limited",
        "audio connection capacity reached",
        1000n,
      );
    this.#pending++;
    let ended = false;
    return () => {
      if (!ended) this.#pending--;
      ended = true;
    };
  }

  /** Validates an audio upgrade; `null` means the path is not an audio path. */
  async authorize(
    url: URL,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AudioTicket | null> {
    const { state } = this;
    if (this.#closing)
      throw new ApiError("provider_unavailable", "managed service is draining");
    const path = AUDIO_PATH.exec(url.pathname);
    if (!path) return null;
    const account = await state.authorize(headers);
    state.requireAssistance();
    let id: string, source: Source;
    try {
      id = validateSessionId(decodeURIComponent(path[1]!));
      source = parseSource(decodeURIComponent(path[2]!));
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
    if (this.#closing)
      throw new ApiError("provider_unavailable", "managed service is draining");
    reserveConnect(state, account.accountId);
    return {
      session,
      source,
      tokenExpiry: account.expiresAtMs,
      language: url.searchParams.get("language") ?? "multi",
    };
  }

  open(ticket: AudioTicket, client: RelaySocket) {
    const { session, source } = ticket;
    const generation = attachSource(
      this.state,
      session,
      source,
      this.state.clock(),
    );
    const key = `${session.id}:${source}`;
    const relay = new Relay(this.state, this, ticket, client, generation);
    const done = relay.run(this.#slots.get(key));
    this.#active.set(client, done);
    this.#slots.set(key, done);
    void done.finally(() => {
      this.#active.delete(client);
      if (this.#slots.get(key) === done) this.#slots.delete(key);
    });
  }

  admit(run: () => bigint | undefined) {
    return this.#admit(run);
  }

  async close() {
    this.#closing = true;
    for (const client of this.#active.keys()) client.terminate();
    await Promise.all(this.#active.values());
  }
}

class Relay {
  upstream: RelaySocket | undefined;
  upstreamOpened = false;
  stopping = false;
  supplierFailure = false;
  pumping = false;
  queuedBytes = 0;
  outputBytes = 0;
  clientCloseCode: number | null = null;
  supplierCloseCode: number | null = null;
  lastDelivered: bigint;
  lastReceived: bigint | null = null;
  receivedBytes = 0;
  deliveredBytes = 0;
  upstreamWriteFailure: string | null = null;
  pumpTask = Promise.resolve();
  queue: Uint8Array[] = [];
  writes = new Set<Promise<void>>();
  nextDelivery: number | undefined;
  refreshing = false;
  lastRefresh: bigint;
  tokenExpiry: bigint;
  monitor: ReturnType<typeof setInterval> | undefined;
  lastTick = performance.now();
  frozenBytes = 0;
  thawTicks = 0;
  droppedBytes = 0;
  finishResolve!: () => void;
  finished = new Promise<void>((resolve) => {
    this.finishResolve = resolve;
  });
  readonly session: SessionRow;
  readonly source: Source;

  constructor(
    readonly state: ServiceState,
    readonly relays: AudioRelay,
    readonly ticket: AudioTicket,
    readonly client: RelaySocket,
    readonly generation: bigint,
  ) {
    this.session = ticket.session;
    this.source = ticket.source;
    this.tokenExpiry = ticket.tokenExpiry;
    this.lastDelivered = state.clock();
    this.lastRefresh = state.clock() - 5000n;
  }

  valid() {
    const { state, session } = this;
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
      sourceGeneration(state, session.id, this.source) === this.generation
    );
  }

  logClosed(reason: string) {
    const { state, upstream } = this;
    const now = state.clock();
    // Log only transport metadata: supplier errors and close text can contain user data.
    console.info(
      JSON.stringify({
        event: "audio_closed",
        source: this.source,
        reason,
        sessionId: this.session.local_session_id,
        supplierFailure: this.supplierFailure,
        lastDeliveredAgeMs: Number(now - this.lastDelivered),
        lastReceivedAgeMs:
          this.lastReceived === null ? null : Number(now - this.lastReceived),
        receivedBytes: this.receivedBytes,
        deliveredBytes: this.deliveredBytes,
        droppedBytes: this.droppedBytes,
        tokenRemainingMs: Number(this.tokenExpiry - now),
        queuedBytes: this.queuedBytes,
        outputBytes: this.outputBytes,
        clientCloseCode: this.clientCloseCode,
        supplierCloseCode: this.supplierCloseCode,
        clientState: this.client.readyState,
        upstreamState: upstream?.readyState ?? null,
        upstreamBufferedBytes: upstream?.bufferedAmount ?? null,
        upstreamWriteFailure: this.upstreamWriteFailure,
      }),
    );
  }

  abandon() {
    const { session } = this;
    abandonFailedSource(
      this.state,
      session.account_id,
      session.local_session_id,
      this.source,
      this.generation,
    );
  }

  async finish(reason: string, providerFailed = false) {
    this.supplierFailure ||= providerFailed;
    if (this.stopping) return;
    this.stopping = true;
    this.logClosed(reason);
    if (this.supplierFailure) {
      console.warn("transcription provider unavailable");
      noteError("transcription_provider_failures_5m");
    }
    clearInterval(this.monitor);
    this.queue.length = 0;
    let abandoned = false;
    if (this.supplierFailure) {
      try {
        this.abandon();
        abandoned = true;
      } catch {
        /* Retry after the pending write settles. */
      }
    }
    const { upstream, session, state } = this;
    if (upstream?.readyState === CONNECTING) upstream.terminate();
    await this.pumpTask.catch(() => {});
    await Promise.allSettled(this.writes);
    try {
      if (this.supplierFailure && !abandoned) this.abandon();
      else if (!this.supplierFailure)
        settleDisconnectedSource(
          state,
          session.account_id,
          session.local_session_id,
          this.source,
          this.generation,
          reason === "client_closed" && this.clientCloseCode === 1006,
        );
    } catch {
      /* Ledger recovery releases any unsettled reservation on lease expiry. */
    }
    detachSource(state, session.id, this.source, this.generation);
    if (upstream?.readyState === OPEN)
      await upstream.send('{"type":"CloseStream"}').catch(() => {});
    await Promise.all([
      this.client.close(),
      ...(upstream ? [upstream.close()] : []),
    ]);
    this.finishResolve();
  }

  async admitChunk(chunk: Uint8Array) {
    const { state, session, source, generation } = this;
    while (!this.stopping) {
      try {
        return await this.relays.admit(() => {
          state.requireAssistance();
          const now = state.clock();
          if (this.stopping || now >= this.tokenExpiry || !this.valid()) return;
          checkAudio(state, session.id, source, generation, chunk.length, now);
          return now;
        });
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.code !== "invalid_request" ||
          error.retryAfterMs === undefined
        )
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, Number(error.retryAfterMs)),
        );
      }
    }
    return undefined;
  }

  async forward(upstream: RelaySocket, chunk: Uint8Array) {
    try {
      this.nextDelivery! += chunk.length / 32;
      await upstream.send(chunk);
    } catch (error) {
      this.upstreamWriteFailure =
        error instanceof Error && SEND_FAILURES.includes(error.message)
          ? error.message
          : "socket write callback";
      this.supplierFailure = true;
      throw new ApiError("provider_unavailable", "transcription write stalled");
    }
  }

  async pace() {
    // Network buffering can bunch up correctly paced client frames.
    this.nextDelivery ??= performance.now();
    for (;;) {
      const delay = Math.ceil(this.nextDelivery - performance.now());
      if (delay <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async pump() {
    const { upstream, state, session } = this;
    if (this.pumping || this.stopping || upstream?.readyState !== OPEN) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.stopping) {
        const chunk = this.queue.shift()!;
        await this.pace();
        if (this.stopping) break;
        const admittedAt = await this.admitChunk(chunk);
        if (
          admittedAt === undefined ||
          this.stopping ||
          state.clock() >= this.tokenExpiry ||
          !this.valid()
        )
          break;
        await this.forward(upstream, chunk);
        if (this.stopping && this.supplierFailure) break;
        this.queuedBytes -= chunk.length;
        const outcome = onAudio(
          state,
          session.account_id,
          session.local_session_id,
          this.source,
          chunk.length,
          state.clock(),
          {
            version: session.lease_version,
            generation: this.generation,
            admittedAt,
          },
        );
        this.lastDelivered = state.clock();
        this.deliveredBytes += chunk.length;
        if (outcome === "exhausted") {
          await this.client
            .send('{"type":"SavvyControl","reason":"quota_exhausted"}')
            .catch(() => {});
          break;
        }
      }
      if (
        !this.stopping &&
        (!this.valid() || state.clock() >= this.tokenExpiry)
      )
        void this.finish("lease_or_token_expired");
    } finally {
      this.pumping = false;
    }
  }

  startPump() {
    if (this.pumping || this.stopping) return;
    this.pumpTask = this.pump();
    void this.pumpTask.catch((error) =>
      this.finish(
        error instanceof ApiError ? `pump_${error.code}` : "pump_failed",
        this.supplierFailure,
      ),
    );
  }

  async renew(text: string) {
    const { state, session } = this;
    try {
      const message = JSON.parse(text);
      if (message.type !== "SavvyAuth" || typeof message.token !== "string")
        throw new Error("invalid audio authorization");
      const identity = await state.authorize({
        authorization: `Bearer ${message.token}`,
      });
      if (
        this.stopping ||
        identity.accountId !== session.account_id ||
        identity.expiresAtMs <= state.clock() ||
        !this.valid()
      )
        throw new Error("invalid audio authorization");
      this.tokenExpiry = identity.expiresAtMs;
      await this.client.send('{"type":"SavvyAuthOk"}');
    } catch {
      await this.client
        .send('{"type":"SavvyControl","reason":"sign_in_required"}')
        .catch(() => {});
      void this.finish("authorization_failed");
    } finally {
      this.refreshing = false;
    }
  }

  onClientFrame(frame: Frame) {
    if (this.stopping) return;
    const { state } = this;
    if (typeof frame === "string") {
      if (
        this.refreshing ||
        state.clock() - this.lastRefresh < 5000n ||
        byteLength(frame) > 8192
      ) {
        void this.finish("invalid_auth_frame");
        return;
      }
      this.lastRefresh = state.clock();
      this.refreshing = true;
      void this.renew(frame);
      return;
    }
    const chunk = frame;
    if (!chunk.length || chunk.length % 2 || chunk.length > MAX_AUDIO) {
      void this.finish("invalid_or_overflowing_audio");
      return;
    }
    this.noticeFreeze();
    if (this.frozenBytes >= chunk.length) {
      this.frozenBytes -= chunk.length;
      this.droppedBytes += chunk.length;
      return;
    }
    if (
      this.queuedBytes + chunk.length >
      (this.upstreamOpened ? MAX_QUEUED_AUDIO : MAX_AUDIO)
    ) {
      void this.finish("invalid_or_overflowing_audio");
      return;
    }
    this.queuedBytes += chunk.length;
    this.receivedBytes += chunk.length;
    this.lastReceived = state.clock();
    this.queue.push(chunk);
    this.startPump();
  }

  noticeFreeze() {
    const tick = performance.now();
    const frozen = Math.round(tick - this.lastTick - MONITOR_MS);
    this.lastTick = tick;
    if (frozen < FREEZE_MS) return;
    this.lastDelivered += BigInt(frozen);
    this.frozenBytes += frozen * 32;
    this.thawTicks = THAW_MS / MONITOR_MS;
  }

  check() {
    if (this.stopping) return;
    const { state, session, upstream } = this;
    this.noticeFreeze();
    if (this.frozenBytes && --this.thawTicks < 0) this.frozenBytes = 0;
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
      else if (now >= this.tokenExpiry) reason = "token_expired";
      else if (!this.valid()) reason = "lease_invalid";
      else if (disabled === undefined || disabled !== 0n)
        reason = "account_disabled";
      else if (
        upstream?.readyState === OPEN &&
        now - this.lastDelivered >= AUDIO_IDLE_MS
      )
        reason = "audio_idle";
      if (reason) {
        void this.finish(reason);
        return;
      }
      if (upstream?.readyState === OPEN)
        onIdleCheck(state, session.account_id, session.local_session_id, now);
    } catch {
      void this.finish("monitor_failed");
    }
  }

  onSupplierFrame(frame: Frame) {
    if (this.stopping || typeof frame !== "string") return;
    let value;
    try {
      value = JSON.parse(frame);
    } catch {
      return;
    }
    if (value?.type !== "Results") return;
    const alternative = value.channel?.alternatives?.[0];
    // Only primitives are forwarded, so supplier nesting cannot reach JSON.stringify.
    const num = (v: unknown) => (Number.isFinite(v) ? (v as number) : null);
    const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
    const start = num(value.start);
    const duration = num(value.duration);
    if (start !== null && duration !== null)
      this.upstream?.processed(Math.round((start + duration) * 32_000));
    const filtered = JSON.stringify({
      type: "Results",
      start,
      duration,
      is_final: bool(value.is_final),
      speech_final: bool(value.speech_final),
      channel: {
        alternatives: [
          {
            transcript:
              typeof alternative?.transcript === "string"
                ? alternative.transcript
                : null,
            confidence: num(alternative?.confidence),
          },
        ],
      },
    });
    const size = byteLength(filtered);
    if (this.outputBytes + size > MAX_TRANSCRIPT) {
      void this.finish("transcript_overflow");
      return;
    }
    this.outputBytes += size;
    const write = this.client.send(filtered);
    this.writes.add(write);
    void write
      .catch(() => this.finish("transcript_write_failed"))
      .finally(() => {
        this.outputBytes -= size;
        this.writes.delete(write);
      });
  }

  async waitForPrevious(previous: Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
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
      clearTimeout(timer);
    }
  }

  connect() {
    const { state } = this;
    const upstream = this.relays.connectSupplier(
      upstreamUrl(state.config.deepgramUrl, this.ticket.language),
      `Token ${state.config.deepgramKey}`,
    );
    this.upstream = upstream;
    const opened = new Promise<void>((resolve, reject) => {
      upstream.listen({
        open: () => {
          this.upstreamOpened = true;
          resolve();
        },
        error: () => {
          reject(new Error("supplier failed during handshake"));
          if (!this.stopping && this.upstreamOpened) {
            this.supplierFailure = true;
            void this.finish("supplier_error", true);
          }
        },
        close: (code) => {
          reject(new Error("supplier closed during handshake"));
          this.supplierCloseCode = code;
          if (!this.stopping && this.upstreamOpened)
            void this.finish("supplier_closed", true);
        },
        message: (frame) => this.onSupplierFrame(frame),
      });
    });
    return opened;
  }

  async handshake(opened: Promise<void>) {
    try {
      await opened;
      return true;
    } catch {
      this.supplierFailure = !this.stopping || this.supplierFailure;
      if (this.supplierFailure)
        await this.client
          .send('{"type":"SavvyControl","reason":"provider_unavailable"}')
          .catch(() => {});
      void this.finish("supplier_handshake_failed", this.supplierFailure);
      return false;
    }
  }

  async run(previous?: Promise<void>) {
    this.client.listen({
      message: (frame) => this.onClientFrame(frame),
      close: (code) => {
        this.clientCloseCode = code;
        void this.finish("client_closed");
      },
      error: () => void this.finish("client_error"),
    });
    this.monitor = setInterval(() => this.check(), MONITOR_MS);
    try {
      if (previous) await this.waitForPrevious(previous);
      if (this.stopping || !this.valid()) {
        void this.finish("lease_invalid_before_supplier");
        return await this.finished;
      }
      if (!(await this.handshake(this.connect()))) return await this.finished;
      if (this.stopping) return await this.finished;
      this.lastDelivered = this.state.clock();
      this.startPump();
      return await this.finished;
    } catch {
      void this.finish("relay_setup_failed", this.supplierFailure);
      return await this.finished;
    }
  }
}
