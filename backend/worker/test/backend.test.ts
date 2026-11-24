import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { createTestHarness } from "wrangler";

const server = createTestHarness({
  workers: [
    {
      configPath: new URL("./entry.wrangler.jsonc", import.meta.url),
      secrets: {
        BETTER_AUTH_SECRET: "workerd-secret-workerd-secret-0123456789",
        SAVVY_ANTHROPIC_API_KEY: "synthetic",
        SAVVY_DEEPGRAM_API_KEY: "synthetic",
      },
    },
  ],
});
const worker = () => server.getWorker();
before(() => server.listen());
after(() => server.close());

type Row = Record<string, unknown>;
let objectId: string;
let token: string;

async function probe<T>(name: string, query = ""): Promise<T> {
  const response = await server.fetch(`/__probe/${name}?${query}`);
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return (name === "token" ? body : JSON.parse(body)) as T;
}

async function sql(query: string): Promise<Row[]> {
  const storage = await worker().getDurableObjectStorage("SavvyBackend", {
    id: objectId,
  });
  return (await storage.exec(query)) as Row[];
}

async function evict() {
  await worker().evictDurableObject("SavvyBackend", { id: objectId });
}

async function api(path: string, body?: unknown) {
  const response = await server.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${path}: ${text}`);
  return JSON.parse(text);
}

async function eventually(check: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `condition not met within ${ms} ms`);
    await sleep(250);
  }
}

const alarmIn = async () => (await probe<{ inMs: number }>("alarm")).inMs;

test("ready, readyz and JWKS answer from the Durable Object", async () => {
  objectId = (await probe<{ id: string }>("alarm")).id;
  const ready = await server.fetch("/ready");
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get("cache-control"), "no-store");
  assert.deepEqual(await ready.json(), {
    status: "ready",
    google: false,
    email: false,
    billing: "unmetered",
  });
  assert.equal((await server.fetch("/readyz")).status, 204);
  const jwks = await server.fetch("/api/auth/jwks");
  assert.equal(jwks.status, 200);
  assert.ok(((await jwks.json()) as { keys: unknown[] }).keys.length > 0);
});

test("unknown paths get 404 and audio gets 501 until CF-4", async () => {
  assert.equal((await server.fetch("/nope")).status, 404);
  assert.equal((await server.fetch("/v1/nope")).status, 404);
  const audio =
    "/v1/sessions/00000000-0000-4000-8000-000000000001/audio/system";
  assert.equal((await server.fetch(audio)).status, 501);
  const page = await server.fetch("/sign-in");
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
  const html = await page.text();
  assert.match(html, /<div id="root">/);
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)![1]!;
  assert.equal((await server.fetch(script)).status, 200);
  const discovery = await server.fetch("/.well-known/openid-configuration");
  assert.equal(discovery.status, 200);
});

test("auth bodies over 65,536 bytes get 413", async () => {
  const post = (size: number) =>
    server.fetch("/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(size),
    });
  assert.equal((await post(65_537)).status, 413);
  assert.notEqual((await post(65_536)).status, 413);
});

test("CF-Connecting-IP gives each client its own rate-limit key", async () => {
  for (const ip of ["198.51.100.7", "203.0.113.9"])
    await server.fetch("/api/auth/get-session", {
      headers: {
        "cf-connecting-ip": ip,
        "x-savvy-client-ip": "192.0.2.1",
        "x-savvy-proxy-ip": "192.0.2.66",
      },
    });
  const keys = (await sql("SELECT key FROM rateLimit")).map((r) => r.key);
  assert.ok(
    !keys.some((key) => /192\.0\.2\.(1|66)\b/.test(String(key))),
    String(keys),
  );
  assert.ok(
    keys.some((key) => String(key).includes("198.51.100.7")),
    String(keys),
  );
  assert.ok(
    keys.some((key) => String(key).includes("203.0.113.9")),
    String(keys),
  );
});

test("requests keep working across Durable Object restarts", async () => {
  server.clearLogs();
  for (let restart = 0; restart < 3; restart++) {
    assert.equal((await server.fetch("/ready")).status, 200);
    await evict();
  }
  assert.equal((await server.fetch("/configuration")).status, 200);
  const logs = JSON.stringify(server.getLogs());
  assert.doesNotMatch(logs, /EADDRINUSE|different Durable Object/);
});

test("a minted JWT reaches /v1, and the alarm idles at 60 s", async () => {
  token = await probe<string>("token");
  const account = await api("/v1/account");
  assert.equal(typeof account, "object");
  const wait = await alarmIn();
  assert.ok(wait > 50_000 && wait <= 60_000, String(wait));
});

test("a paused session survives eviction, idles the alarm and resumes", async () => {
  const sessionId = "00000000-0000-4000-8000-00000000000a";
  const created = await api("/v1/sessions", { sessionId });
  assert.ok((await alarmIn()) <= 1000);
  const paused = await api(`/v1/sessions/${sessionId}/pause`, {
    leaseVersion: Number(created.leaseVersion),
    commandId: 1,
  });
  assert.equal(paused.state, "paused");
  await evict();
  assert.equal((await server.fetch("/ready")).status, 200);
  const [row] = await sql(
    `SELECT state,lease_version,reserved_ms FROM managed_sessions WHERE local_session_id='${sessionId}'`,
  );
  assert.deepEqual(row, {
    state: "paused",
    lease_version: Number(paused.leaseVersion),
    reserved_ms: 0,
  });
  await eventually(async () => (await alarmIn()) > 50_000, 3000);
  const resumed = await api(`/v1/sessions/${sessionId}/resume`, {
    leaseVersion: Number(paused.leaseVersion),
    commandId: 2,
  });
  assert.equal(resumed.state, "active");
  assert.ok((await alarmIn()) <= 1000);
  await api(`/v1/sessions/${sessionId}/stop`, {
    leaseVersion: Number(resumed.leaseVersion),
    commandId: 3,
  });
  await eventually(async () => (await alarmIn()) > 50_000, 3000);
});

test(
  "an active session evicted mid-stream ends through its lease",
  { timeout: 60_000 },
  async () => {
    const sessionId = "00000000-0000-4000-8000-00000000000b";
    await api("/v1/sessions", { sessionId });
    await probe("audio", `session=${sessionId}&ms=6000`);
    const where = `local_session_id='${sessionId}'`;
    const [billed] = await sql(
      `SELECT settled_ms FROM managed_sessions WHERE ${where}`,
    );
    assert.ok(Number(billed!.settled_ms) >= 5000, String(billed!.settled_ms));
    await evict();
    const [kept] = await sql(
      `SELECT state,reserved_ms,billable_since_ms FROM managed_sessions WHERE ${where}`,
    );
    assert.equal((await server.fetch("/ready")).status, 200);
    assert.equal(kept!.state, "active");
    assert.ok(Number(kept!.reserved_ms) > 0);
    await eventually(
      async () =>
        (await sql(`SELECT state FROM managed_sessions WHERE ${where}`))[0]!
          .state === "stopped",
      40_000,
    );
    const [ended] = await sql(
      `SELECT settled_ms,reserved_ms,(SELECT count(*) FROM session_reservations) AS open,(SELECT sum(meeting_ms_reserved) FROM allowance_grants) AS held,(SELECT sum(amount_ms) FROM usage_events WHERE kind='debit_meeting' AND session_id='${sessionId}') AS debited FROM managed_sessions WHERE ${where}`,
    );
    assert.deepEqual(ended, {
      settled_ms: billed!.settled_ms,
      reserved_ms: 0,
      open: 0,
      held: 0,
      debited: billed!.settled_ms,
    });
  },
);

test("the alarm re-arms after a throwing tick", async () => {
  await sql(
    "CREATE TRIGGER forced_tick_failure BEFORE DELETE ON cancellation_tombstones BEGIN SELECT RAISE(ABORT, 'forced tick failure'); END",
  );
  await sql(
    "INSERT INTO cancellation_tombstones SELECT id,'expired',0 FROM accounts LIMIT 1",
  );
  try {
    server.clearLogs();
    await probe("fire");
    await eventually(
      async () =>
        server
          .getLogs()
          .some((log) => /maintenance tick failed/.test(JSON.stringify(log))),
      5000,
    );
    const wait = await alarmIn();
    assert.ok(wait > 50_000 && wait <= 60_000, String(wait));
  } finally {
    await sql("DROP TRIGGER forced_tick_failure");
  }
});

test("each client IP gets its own limit of 3 sign-in code requests a minute", async () => {
  let sent = 0;
  const send = async (ip: string) => {
    sent += 1;
    const response = await server.fetch(
      "/api/auth/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": ip,
          origin: "http://127.0.0.1:8788",
        },
        body: JSON.stringify({
          email: `limit-${sent}@example.com`,
          type: "sign-in",
        }),
      },
    );
    await response.text();
    return response.status;
  };
  const first: number[] = [];
  for (let i = 0; i < 4; i++) first.push(await send("198.51.100.41"));
  assert.deepEqual(
    first.map((status) => status === 429),
    [false, false, false, true],
    String(first),
  );
  assert.notEqual(await send("203.0.113.42"), 429);
});

test("a fresh instance re-arms a missing alarm on boot", async () => {
  await probe("clear-alarm");
  assert.equal(await alarmIn(), null);
  await evict();
  assert.notEqual(await alarmIn(), null);
});
