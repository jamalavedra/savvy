import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { openServiceDatabase } from "./db.js";
import { ServiceState } from "./state.js";
import { configuration } from "./config.js";
import { ApiError } from "./errors.js";
import { insertGrant, balance } from "./billing.js";
import { createSession, sessionView, lifecycle } from "./sessions.js";
import { attachAudio, upstreamUrl } from "./transcription.js";

const ID = "00000000-0000-0000-0000-000000000001";
async function fixture(
  t: TestContext,
  rejectSupplier: boolean | "stall" = false,
) {
  const db = openServiceDatabase(":memory:");
  let now = 1_700_000_000_000n;
  let supplierConnections = 0,
    forwarded = 0;
  const supplier = createServer();
  const rawSupplierSockets = new Set<Duplex>();
  const supplierSockets = new WebSocketServer({ noServer: true });
  supplier.on("upgrade", (req, socket, head) => {
    rawSupplierSockets.add(socket);
    socket.on("close", () => rawSupplierSockets.delete(socket));
    supplierConnections++;
    assert.equal(req.headers.authorization, "Token synthetic");
    const url = new URL(req.url!, "http://supplier");
    assert.equal(url.searchParams.get("model"), "nova-3");
    assert.equal(url.searchParams.get("mip_opt_out"), "true");
    if (rejectSupplier === "stall") return;
    if (rejectSupplier) {
      socket.end("HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    supplierSockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => {});
      ws.on("message", (data, binary) => {
        if (!binary) return;
        forwarded += (data as Buffer).length;
        ws.send(
          JSON.stringify({
            type: "Results",
            start: 0,
            duration: 0.02,
            is_final: true,
            speech_final: true,
            metadata: { secret: "must disappear" },
            channel: {
              alternatives: [
                {
                  transcript: "Synthetic transcript",
                  confidence: 0.9,
                  words: [{ word: "hidden" }],
                },
              ],
            },
          }),
        );
      });
    });
  });
  supplier.listen(0, "127.0.0.1");
  await once(supplier, "listening");
  const supplierAddress = supplier.address();
  assert.ok(supplierAddress && typeof supplierAddress !== "string");
  const state = new ServiceState(
    configuration({
      SAVVY_STRIPE_SECRET_KEY: "synthetic",
      SAVVY_STRIPE_WEBHOOK_SECRET: "synthetic",
      SAVVY_STRIPE_PRICE_MONTHLY: "price_monthly",
      SAVVY_STRIPE_PRICE_PACK: "price_pack",
      SAVVY_ANTHROPIC_API_KEY: "synthetic",
      SAVVY_DEEPGRAM_API_KEY: "synthetic",
      SAVVY_DEEPGRAM_URL: `ws://127.0.0.1:${supplierAddress.port}/listen`,
    }),
    db,
    () => now,
    async (headers) => {
      if (headers.authorization !== "Bearer valid")
        throw new ApiError("sign_in_required", "invalid test token");
      return {
        accountId: 1n,
        subject: "a",
        expiresAtMs: now + 60_000n,
        displayIdentity: {
          issuer: "issuer",
          subject: "a",
          name: null,
          email: null,
          emailVerified: false,
        },
      };
    },
  );
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','a',0)",
  ).run();
  db.transaction(() => {
    insertGrant(db, 1n, "pack", "pack", 10_800_000n, 6n, now, null);
    createSession(db, 1n, ID, now);
  }).immediate();
  const server = createServer();
  let closeAudio = attachAudio(server, state);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `ws://127.0.0.1:${address.port}/v1/sessions/${ID}/audio`;
  t.after(async () => {
    await closeAudio();
    for (const ws of supplierSockets.clients) ws.terminate();
    supplierSockets.close();
    for (const socket of rawSupplierSockets) socket.destroy();
    for (const listener of [server, supplier]) {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    db.close();
  });
  const connect = (source = "microphone", token = "valid", version = 1) => {
    const ws = new WebSocket(
      `${base}/${source}?leaseVersion=${version}&language=ca`,
      { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 2000 },
    );
    ws.on("error", () => {});
    return ws;
  };
  return {
    state,
    db,
    connect,
    closeAudio,
    async reopenRelay() {
      await closeAudio();
      closeAudio = attachAudio(server, state);
    },
    supplierSockets,
    advance(ms: bigint) {
      now += ms;
    },
    view: () => sessionView(db, 1n, ID, now),
    calls: () => supplierConnections,
    forwarded: () => forwarded,
  };
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "condition did not settle");
}

test("audio upgrade rejects unauthorized and stale leases before supplier connection", async (t) => {
  const h = await fixture(t);
  for (const [token, version] of [
    ["wrong", 1],
    ["valid", 99],
  ] as const) {
    const ws = h.connect("microphone", token, version);
    await assert.rejects(once(ws, "open"));
    assert.equal(h.calls(), 0);
  }
  const ws = h.connect("unknown");
  await assert.rejects(once(ws, "open"));
  assert.equal(h.calls(), 0);
});

test("supplier handshake failure delivers typed control and never charges", async (t) => {
  const h = await fixture(t, true),
    ws = h.connect();
  const message = once(ws, "message");
  const closed = once(ws, "close");
  await once(ws, "open");
  const [data] = await message;
  assert.deepEqual(JSON.parse(String(data)), {
    type: "SavvyControl",
    reason: "provider_unavailable",
  });
  await closed;
  assert.equal(h.view().settledMs, 0n);
  assert.equal(h.calls(), 1);
});

test("silent reconnect attempts are durably limited before supplier handshakes", async (t) => {
  const h = await fixture(t, true);
  for (let attempt = 0; attempt < 12; attempt++) {
    const ws = h.connect();
    await once(ws, "close");
  }
  assert.equal(h.calls(), 12);
  await h.reopenRelay();
  const limited = h.connect();
  await assert.rejects(once(limited, "open"));
  assert.equal(h.calls(), 12);
  assert.equal(h.view().settledMs, 0n);
});

test("accepted PCM produces filtered transcripts and EOF settles full observed coverage once", async (t) => {
  const h = await fixture(t),
    ws = h.connect();
  await once(ws, "open");
  const message = once(ws, "message");
  ws.send(Buffer.alloc(640));
  const [data] = await message;
  assert.deepEqual(JSON.parse(String(data)), {
    type: "Results",
    start: 0,
    duration: 0.02,
    is_final: true,
    speech_final: true,
    channel: {
      alternatives: [{ transcript: "Synthetic transcript", confidence: 0.9 }],
    },
  });
  assert.equal(h.forwarded(), 640);
  const closed = once(ws, "close");
  ws.close();
  await closed;
  await waitFor(() => h.view().state === "paused");
  assert.equal(h.view().settledMs, 20n);
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 0n);
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT count(*) AS n FROM usage_events WHERE kind='debit_meeting'",
      )
      .get(),
    { n: 1n },
  );
});

test("invalid terminal frame settles earlier accepted audio and stops both sockets", async (t) => {
  const h = await fixture(t),
    ws = h.connect();
  await once(ws, "open");
  const message = once(ws, "message");
  ws.send(Buffer.alloc(640));
  await message;
  const closed = once(ws, "close");
  ws.send(Buffer.alloc(3));
  await closed;
  await waitFor(() => h.view().state === "paused");
  assert.equal(h.view().settledMs, 20n);
  assert.equal(h.forwarded(), 640);
  await waitFor(() => h.supplierSockets.clients.size === 0);
});

test("two sources share coverage, superseded connections close, and pause prevents further delivery", async (t) => {
  const h = await fixture(t),
    mic = h.connect(),
    system = h.connect("system");
  await Promise.all([once(mic, "open"), once(system, "open")]);
  const transcripts = [once(mic, "message"), once(system, "message")];
  mic.send(Buffer.alloc(640));
  system.send(Buffer.alloc(640));
  await Promise.all(transcripts);
  const oldClosed = once(mic, "close");
  const next = h.connect();
  await once(next, "open");
  await oldClosed;
  assert.equal(h.view().state, "active");
  await waitFor(() => h.calls() === 3);
  h.advance(20n);
  const nextTranscript = once(next, "message");
  next.send(Buffer.alloc(640));
  await nextTranscript;
  h.advance(20n);
  const closed = [once(next, "close"), once(system, "close")];
  lifecycle(h.state, 1n, ID, "pause", 1n, 1n);
  await Promise.all(closed);
  assert.equal(h.view().settledMs, 40n);
  assert.equal(h.forwarded(), 1920);
});

test("supplier loss absorbs uncheckpointed time while explicit drain settles observed audio", async (t) => {
  for (const drain of [false, true]) {
    const h = await fixture(t),
      ws = h.connect();
    await once(ws, "open");
    const transcript = once(ws, "message");
    ws.send(Buffer.alloc(640));
    await transcript;
    const closed = once(ws, "close");
    if (drain) {
      h.state.draining = true;
      await h.closeAudio();
    } else for (const socket of h.supplierSockets.clients) socket.terminate();
    await closed;
    assert.equal(h.view().settledMs, drain ? 20n : 0n);
  }
});

test("reconnecting after supplier loss never debits the abandoned audio tail", async (t) => {
  const h = await fixture(t);
  const first = h.connect();
  await once(first, "open");
  const received = once(first, "message");
  first.send(Buffer.alloc(640));
  await received;
  const closed = once(first, "close");
  for (const socket of h.supplierSockets.clients) socket.terminate();
  await closed;
  assert.equal(h.view().settledMs, 0n);
  h.advance(100n);
  const next = h.connect();
  await once(next, "open");
  const fresh = once(next, "message");
  next.send(Buffer.alloc(640));
  await fresh;
  assert.equal(h.view().settledMs, 0n);
  const stopped = once(next, "close");
  next.close();
  await stopped;
  await waitFor(() => h.view().state === "paused");
  assert.equal(h.view().settledMs, 20n);
});

test("upstream language selection fixes the supplier model and replaces caller query options", () => {
  const url = new URL(
    upstreamUrl("wss://supplier/listen?model=other", "klingon"),
  );
  assert.equal(url.searchParams.get("language"), "multi");
  assert.equal(url.searchParams.get("model"), "nova-3");
});

test("idle and disabled accounts close supplier work without charging a silent tail", async (t) => {
  for (const disabled of [false, true]) {
    const h = await fixture(t),
      ws = h.connect();
    await once(ws, "open");
    const transcript = once(ws, "message");
    ws.send(Buffer.alloc(640));
    await transcript;
    const closed = once(ws, "close");
    if (disabled) h.db.prepare("UPDATE accounts SET disabled=1").run();
    else h.advance(5000n);
    await closed;
    await waitFor(() => h.supplierSockets.clients.size === 0);
    assert.equal(h.view().settledMs, 20n);
    assert.equal(h.view().state, "paused");
  }
});

test("a stalled supplier handshake cannot buffer more than one second of client audio", async (t) => {
  const h = await fixture(t, "stall"),
    ws = h.connect();
  await once(ws, "open");
  await waitFor(() => h.calls() === 1);
  const closed = once(ws, "close");
  ws.send(Buffer.alloc(16000));
  ws.send(Buffer.alloc(16000));
  ws.send(Buffer.alloc(2));
  await closed;
  await waitFor(() => h.view().state === "paused");
  assert.equal(h.view().settledMs, 0n);
  assert.equal(h.forwarded(), 0);
});

test("quota exhaustion delivers explicit control and purchase does not reopen audio", async (t) => {
  const h = await fixture(t);
  h.db
    .prepare(
      "UPDATE allowance_grants SET meeting_ms_total=20,meeting_ms_reserved=20",
    )
    .run();
  h.db.prepare("UPDATE managed_sessions SET reserved_ms=20").run();
  h.db.prepare("UPDATE session_reservations SET amount_ms=20").run();
  const ws = h.connect();
  await once(ws, "open");
  const transcript = once(ws, "message");
  ws.send(Buffer.alloc(640));
  await transcript;
  h.advance(20n);
  const controls: unknown[] = [];
  ws.on("message", (data) => {
    const value = JSON.parse(String(data));
    if (value.type === "SavvyControl") controls.push(value);
  });
  const closed = once(ws, "close");
  ws.send(Buffer.alloc(32));
  await closed;
  assert.deepEqual(controls, [
    { type: "SavvyControl", reason: "quota_exhausted" },
  ]);
  assert.equal(h.view().settledMs, 20n);
  h.db
    .transaction(() =>
      insertGrant(
        h.db,
        1n,
        "new_pack",
        "pack",
        1000n,
        0n,
        h.state.clock(),
        null,
      ),
    )
    .immediate();
  const reconnect = h.connect();
  await assert.rejects(once(reconnect, "open"));
  assert.equal(h.calls(), 1);
});

test("a stalled transcript consumer closes the relay with bounded queued output", async (t) => {
  const h = await fixture(t),
    ws = h.connect();
  await once(ws, "open");
  const transcript = once(ws, "message");
  ws.send(Buffer.alloc(640));
  await transcript;
  ws.pause();
  try {
    const payload = JSON.stringify({
      type: "Results",
      channel: { alternatives: [{ transcript: "x".repeat(800_000) }] },
    });
    for (const upstream of h.supplierSockets.clients)
      for (let i = 0; i < 6; i++) upstream.send(payload);
    await waitFor(() => h.view().state === "paused");
    assert.equal(h.view().settledMs, 20n);
    await waitFor(() => h.supplierSockets.clients.size === 0);
  } finally {
    ws.resume();
    ws.terminate();
  }
});

test("dual sources idle independently and account disable closes the remaining supplier without billing the gap", async (t) => {
  const h = await fixture(t),
    mic = h.connect(),
    system = h.connect("system");
  await Promise.all([once(mic, "open"), once(system, "open")]);
  const first = [once(mic, "message"), once(system, "message")];
  mic.send(Buffer.alloc(640));
  system.send(Buffer.alloc(640));
  await Promise.all(first);
  assert.equal(h.calls(), 2);
  h.advance(4990n);
  const transcript = once(system, "message");
  system.send(Buffer.alloc(640));
  await transcript;
  const micClosed = once(mic, "close");
  h.advance(20n);
  await micClosed;
  assert.equal(system.readyState, WebSocket.OPEN);
  await waitFor(() => h.supplierSockets.clients.size === 1);
  const systemClosed = once(system, "close");
  h.db.prepare("UPDATE accounts SET disabled=1").run();
  await systemClosed;
  await waitFor(() => h.supplierSockets.clients.size === 0);
  assert.ok(h.view().settledMs <= 40n);
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 0n);
});
