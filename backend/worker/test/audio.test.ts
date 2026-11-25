import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { createTestHarness } from "wrangler";
import { ADMIN_TOKEN, sealEmpty } from "./seal.ts";

const configPath = new URL("./entry.wrangler.jsonc", import.meta.url);
const secrets = {
  BETTER_AUTH_SECRET: "workerd-secret-workerd-secret-0123456789",
  SAVVY_ANTHROPIC_API_KEY: "synthetic",
  SAVVY_DEEPGRAM_API_KEY: "synthetic",
  ADMIN_TOKEN,
};
const server = createTestHarness({ workers: [{ configPath, secrets }] });
const FRAME = 3200;
const FRAME_MS = 100;
const MAX_QUEUED_AUDIO = 160_000;
const PACING_TOLERANCE_MS = 1000;
let base: URL;
let objectId: string;

before(async () => {
  base = (await server.listen()).url;
  await sealEmpty(server.fetch);
  objectId = (await probe<{ id: string }>("alarm")).id;
});
after(() => server.close());

type Row = Record<string, unknown>;
interface Diagnostic {
  reason: string;
  supplierFailure: boolean;
  clientCloseCode: number | null;
  upstreamBufferedBytes: number | null;
  upstreamWriteFailure: string | null;
  sessionId: string;
  deliveredBytes: number;
  droppedBytes: number;
}

async function probe<T>(name: string, query = ""): Promise<T> {
  const response = await server.fetch(`/__probe/${name}?${query}`);
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return (name === "token" ? body : JSON.parse(body)) as T;
}

async function deepgram(action: string) {
  const response = await server.fetch(`/__deepgram/${action}`);
  return (await response.json()) as {
    connections: number;
    forwarded: number;
    open: number;
    requests: { authorization: string; query: string }[];
    closeCodes: number[];
  };
}

async function sql(query: string): Promise<Row[]> {
  const storage = await server
    .getWorker()
    .getDurableObjectStorage("SavvyBackend", { id: objectId });
  return (await storage.exec(query)) as Row[];
}

async function eventually(check: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `condition not met within ${ms} ms`);
    await sleep(100);
  }
}

async function stop(m: Meeting, commandId = 1) {
  await api(m.token, `/v1/sessions/${m.id}/stop`, {
    leaseVersion: m.leaseVersion,
    commandId,
  });
}

async function api(token: string, path: string, body: unknown) {
  const response = await server.fetch(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${path}: ${text}`);
  return JSON.parse(text);
}

let sessions = 0;
async function meeting(user: string) {
  const token = await probe<string>("token", `sub=${user}`);
  const id = `00000000-0000-4000-8000-${String(++sessions).padStart(12, "0")}`;
  const created = await api(token, "/v1/sessions", { sessionId: id });
  return { token, id, leaseVersion: Number(created.leaseVersion) };
}

type Meeting = Awaited<ReturnType<typeof meeting>>;

function connect(m: Meeting, source = "microphone") {
  const url = new URL(
    `/v1/sessions/${m.id}/audio/${source}?leaseVersion=${m.leaseVersion}&language=ca`,
    base,
  );
  url.protocol = "ws:";
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${m.token}` },
  });
  ws.on("error", () => {});
  const messages: string[] = [];
  ws.on("message", (data) => messages.push(String(data)));
  return { ws, messages };
}

async function stream(ws: WebSocket, ms: number, every = FRAME_MS) {
  const started = performance.now();
  for (let sent = 0; sent < ms && ws.readyState === WebSocket.OPEN;) {
    ws.send(Buffer.alloc(FRAME));
    sent += every;
    await sleep(Math.max(0, started + sent - performance.now()));
  }
}

async function row(id: string) {
  const [session] = await sql(
    `SELECT state,settled_ms,reserved_ms,(SELECT count(*) FROM session_reservations r WHERE r.session_id=s.id) AS open,(SELECT coalesce(sum(amount_ms),0) FROM usage_events WHERE kind='debit_meeting' AND session_id='${id}') AS debited,(SELECT coalesce(sum(meeting_ms_reserved),0) FROM allowance_grants g WHERE g.account_id=s.account_id) AS held FROM managed_sessions s WHERE local_session_id='${id}'`,
  );
  return session as {
    state: string;
    settled_ms: number;
    reserved_ms: number;
    open: number;
    debited: number;
    held: number;
  };
}

function closedLog(id: string): Diagnostic | undefined {
  for (const log of server.getLogs().toReversed()) {
    const match = /\{"event":"audio_closed".*?\}(?=["\s]|$)/.exec(
      JSON.stringify(log).replaceAll('\\"', '"'),
    );
    if (!match) continue;
    const diagnostic = JSON.parse(match[0]) as Diagnostic;
    if (diagnostic.sessionId === id) return diagnostic;
  }
  return undefined;
}

async function diagnostic(id: string) {
  await eventually(async () => closedLog(id) !== undefined, 5000);
  return closedLog(id)!;
}

function assertDebits(ended: Awaited<ReturnType<typeof row>>, ms: number) {
  assert.equal(ended.reserved_ms, 0);
  assert.equal(ended.open, 0);
  assert.equal(ended.debited, ended.settled_ms);
  assert.ok(
    Math.abs(ended.settled_ms - ms) <= PACING_TOLERANCE_MS,
    `settled ${ended.settled_ms} ms for ${ms} ms of audio`,
  );
}

test("a stream delivers transcripts and settles on client close", async () => {
  await deepgram("reset");
  const m = await meeting("stream-user");
  const { ws, messages } = connect(m);
  await once(ws, "open");
  await stream(ws, 3000);
  await eventually(async () => messages.length >= 3, 3000);
  assert.deepEqual(JSON.parse(messages[0]!), {
    type: "Results",
    start: 0,
    duration: 1,
    is_final: true,
    speech_final: true,
    channel: {
      alternatives: [{ transcript: "Synthetic transcript", confidence: 0.9 }],
    },
  });
  const supplier = await deepgram("stats");
  assert.equal(supplier.forwarded, 30 * FRAME);
  assert.equal(supplier.requests[0]!.authorization, "Token synthetic");
  assert.match(supplier.requests[0]!.query, /model=nova-3/);
  assert.match(supplier.requests[0]!.query, /language=ca/);
  const closed = once(ws, "close");
  ws.close();
  await closed;
  await eventually(async () => (await row(m.id)).state === "paused", 5000);
  assertDebits(await row(m.id), 3000);
  assert.equal((await diagnostic(m.id)).reason, "client_closed");
  await eventually(async () => (await deepgram("stats")).open === 0, 3000);
});

test("rejections before upgrade answer with the JSON error body", async () => {
  const m = await meeting("reject-user");
  const url = `/v1/sessions/${m.id}/audio/microphone?leaseVersion=99`;
  const upgrade = { upgrade: "websocket", connection: "Upgrade" };
  const stale = await server.fetch(url, {
    headers: { ...upgrade, authorization: `Bearer ${m.token}` },
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    code: "session_conflict",
    message: "expired or stale lease",
  });
  const unsigned = await server.fetch(url, { headers: upgrade });
  assert.equal(unsigned.status, 401);
  assert.equal(
    ((await unsigned.json()) as { code: string }).code,
    "sign_in_required",
  );
});

test(
  "the 129th audio socket is refused at the capacity ceiling",
  {
    timeout: 120_000,
  },
  async () => {
    await deepgram("reset");
    const meetings: Meeting[] = [];
    for (let i = 0; i < 64; i++) meetings.push(await meeting(`capacity-${i}`));
    const sockets = meetings.flatMap((m) =>
      ["microphone", "system"].map((source) => connect(m, source).ws),
    );
    await Promise.all(sockets.map((ws) => once(ws, "open")));
    const extra = await meeting("capacity-extra");
    const refused = await server.fetch(
      `/v1/sessions/${extra.id}/audio/microphone?leaseVersion=${extra.leaseVersion}`,
      {
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          authorization: `Bearer ${extra.token}`,
        },
      },
    );
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), {
      code: "rate_limited",
      message: "audio connection capacity reached",
      retryAfterMs: 1000,
    });
    const closed = sockets.map((ws) => once(ws, "close"));
    for (const ws of sockets) ws.close();
    await Promise.all(closed);
    await eventually(async () => (await deepgram("stats")).open === 0, 10_000);
    const retry = connect(extra);
    await once(retry.ws, "open");
    retry.ws.close();
    await once(retry.ws, "close");
  },
);

test("a supplier close ends the stream on the supplier-failure path", async () => {
  await deepgram("reset");
  const m = await meeting("supplier-close-user");
  const { ws } = connect(m);
  await once(ws, "open");
  await stream(ws, 1000);
  const closed = once(ws, "close");
  await deepgram("close");
  await closed;
  const closing = await diagnostic(m.id);
  assert.equal(closing.reason, "supplier_closed");
  assert.equal(closing.supplierFailure, true);
  const status = await server.fetch("/__admin/status", {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const counts = (await status.json()) as Record<string, number>;
  assert.ok(
    counts.transcription_provider_failures_5m! >= 1,
    JSON.stringify(counts),
  );
  const kept = await row(m.id);
  assert.equal(kept.state, "active");
  await stop(m);
  const ended = await row(m.id);
  assert.equal(ended.state, "stopped");
  assert.equal(ended.reserved_ms, 0);
  assert.equal(ended.open, 0);
  assert.equal(ended.debited, ended.settled_ms);
  assert.equal(ended.settled_ms, kept.settled_ms);
});

test(
  "a stalled supplier fails within a bounded backlog",
  {
    timeout: 30_000,
  },
  async () => {
    await deepgram("reset");
    await deepgram("stall");
    const m = await meeting("stall-user");
    const { ws } = connect(m);
    await once(ws, "open");
    const closed = once(ws, "close");
    await stream(ws, 9000);
    await closed;
    const stalled = await diagnostic(m.id);
    assert.equal(stalled.reason, "pump_provider_unavailable");
    assert.equal(stalled.supplierFailure, true);
    assert.equal(stalled.upstreamWriteFailure, "socket output limit");
    assert.ok(stalled.upstreamBufferedBytes! <= MAX_QUEUED_AUDIO);
    const supplier = await deepgram("stats");
    assert.ok(supplier.forwarded <= MAX_QUEUED_AUDIO);
    await eventually(async () => (await deepgram("stats")).open === 0, 3000);
    assert.deepEqual((await deepgram("stats")).closeCodes, [1005]);
    assert.equal((await row(m.id)).state, "active");
    await deepgram("reset");
    const next = connect(m);
    await once(next.ws, "open");
    await stream(next.ws, 1000);
    await eventually(async () => next.messages.length === 1, 3000);
    next.ws.close();
    await once(next.ws, "close");
    await eventually(async () => (await row(m.id)).state === "paused", 5000);
  },
);

test(
  "a supplier that never completes the upgrade fails after 10 s",
  {
    timeout: 30_000,
  },
  async () => {
    await deepgram("reset");
    await deepgram("hang");
    const m = await meeting("hang-user");
    const started = performance.now();
    const { ws, messages } = connect(m);
    await once(ws, "open");
    await once(ws, "close");
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 10_000 && elapsed < 12_000, String(elapsed));
    assert.deepEqual(
      messages.map((text) => JSON.parse(text)),
      [{ type: "SavvyControl", reason: "provider_unavailable" }],
    );
    const failed = await diagnostic(m.id);
    assert.equal(failed.reason, "supplier_handshake_failed");
    assert.equal(failed.supplierFailure, true);
    await deepgram("reset");
    await stop(m);
  },
);

test("an abrupt client drop keeps the meeting active for a reconnect", async () => {
  await deepgram("reset");
  const m = await meeting("drop-user");
  const first = connect(m);
  await once(first.ws, "open");
  await stream(first.ws, 1000);
  first.ws.terminate();
  const dropped = await diagnostic(m.id);
  assert.equal(dropped.reason, "client_closed");
  assert.equal(dropped.clientCloseCode, 1006);
  const kept = await row(m.id);
  assert.equal(kept.state, "active");
  assert.ok(kept.settled_ms > 0);
  const next = connect(m);
  await once(next.ws, "open");
  await stream(next.ws, 1000);
  next.ws.close();
  await once(next.ws, "close");
  await eventually(async () => (await row(m.id)).state === "paused", 5000);
  assertDebits(await row(m.id), 2000);
});

test("a client that stops reading frees its source after a supplier close", async () => {
  await deepgram("reset");
  const m = await meeting("deaf-user");
  const first = connect(m);
  await once(first.ws, "open");
  await stream(first.ws, 1000);
  (first.ws as unknown as { _socket: { pause(): void } })._socket.pause();
  await deepgram("close");
  assert.equal((await diagnostic(m.id)).reason, "supplier_closed");
  const next = connect(m);
  await once(next.ws, "open");
  await stream(next.ws, 2000);
  await eventually(async () => next.messages.length === 2, 3000);
  assert.equal(next.ws.readyState, WebSocket.OPEN);
  first.ws.terminate();
  next.ws.close();
  await once(next.ws, "close");
  await eventually(async () => (await row(m.id)).state === "paused", 5000);
});

test(
  "a stream survives a sign-in transaction held for 6 s",
  {
    timeout: 40_000,
  },
  async () => {
    await deepgram("reset");
    const m = await meeting("held-user");
    const { ws, messages } = connect(m);
    await once(ws, "open");
    const streamed = stream(ws, 14_000);
    await eventually(async () => messages.length >= 2, 5000);
    await sleep(500);
    const held = probe("hold-auth", "ms=6000");
    await sleep(500);
    const before = messages.length;
    await streamed;
    await held;
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.ok(messages.length > before + 3, `${before} -> ${messages.length}`);
    ws.close();
    await once(ws, "close");
    await eventually(async () => (await row(m.id)).state === "paused", 5000);
    const closing = await diagnostic(m.id);
    assert.equal(closing.reason, "client_closed");
    assert.ok(
      Math.abs(closing.droppedBytes / 32 - 6000) <= PACING_TOLERANCE_MS,
      String(closing.droppedBytes),
    );
    assertDebits(await row(m.id), closing.deliveredBytes / 32);
    assert.ok(
      closing.deliveredBytes / 32 >= 14_000 - 6000 - PACING_TOLERANCE_MS,
    );
  },
);

test(
  "a stream survives a 1 s transaction queued behind a 6 s hold",
  {
    timeout: 40_000,
  },
  async () => {
    await deepgram("reset");
    const m = await meeting("chained-hold-user");
    const { ws, messages } = connect(m);
    await once(ws, "open");
    const streamed = stream(ws, 14_000);
    await eventually(async () => messages.length >= 2, 5000);
    await sleep(500);
    const held = probe("hold-auth", "ms=6000");
    await sleep(200);
    const chained = probe("hold-auth", "ms=1000");
    await held;
    await chained;
    await streamed;
    await sleep(300);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
    await once(ws, "close");
    await eventually(async () => (await row(m.id)).state === "paused", 5000);
    const closing = await diagnostic(m.id);
    assert.equal(closing.reason, "client_closed");
    assertDebits(await row(m.id), closing.deliveredBytes / 32);
  },
);

test(
  "resetting the object mid-stream ends the session through its lease",
  {
    timeout: 60_000,
  },
  async () => {
    await deepgram("reset");
    const m = await meeting("reset-user");
    const { ws } = connect(m);
    await once(ws, "open");
    const closed = once(ws, "close");
    void stream(ws, 15_000);
    await sleep(7000);
    await server.fetch("/__probe/reset").catch(() => {});
    await closed;
    assert.equal((await server.fetch("/ready")).status, 200);
    const kept = await row(m.id);
    assert.equal(kept.state, "active");
    assert.ok(kept.reserved_ms > 0);
    assert.ok(
      kept.settled_ms > 0 && kept.settled_ms <= 7000 + PACING_TOLERANCE_MS,
      String(kept.settled_ms),
    );
    await eventually(async () => (await row(m.id)).state === "stopped", 40_000);
    const ended = await row(m.id);
    assert.equal(ended.reserved_ms, 0);
    assert.equal(ended.open, 0);
    assert.equal(ended.held, 0);
    assert.equal(ended.settled_ms, kept.settled_ms);
    assert.equal(ended.debited, kept.settled_ms);
  },
);
