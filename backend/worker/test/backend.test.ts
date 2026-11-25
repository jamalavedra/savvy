import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { createTestHarness } from "wrangler";
import { ADMIN_TOKEN, sealEmpty } from "./seal.ts";

const server = createTestHarness({
  workers: [
    {
      configPath: new URL("./entry.wrangler.jsonc", import.meta.url),
      secrets: {
        BETTER_AUTH_SECRET: "workerd-secret-workerd-secret-0123456789",
        SAVVY_ANTHROPIC_API_KEY: "synthetic",
        SAVVY_DEEPGRAM_API_KEY: "synthetic",
        ADMIN_TOKEN,
      },
    },
  ],
});
const worker = () => server.getWorker();
before(async () => {
  await server.listen();
  await sealEmpty(server.fetch);
  objectId = (await probe<{ id: string }>("alarm")).id;
});
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

test("the admin status route reports alarm runs and monitor invariants", async () => {
  const status = async (authorization = `Bearer ${ADMIN_TOKEN}`) => {
    const response = await server.fetch("/__admin/status", {
      headers: { authorization },
    });
    return { code: response.status, body: (await response.json()) as Row };
  };
  assert.equal((await status("")).code, 401);
  assert.equal((await status("Bearer wrong")).code, 401);
  const fired = Date.now();
  await probe("fire");
  await eventually(
    async () => Number((await status()).body.lastAlarmAtMs) >= fired,
    5000,
  );
  const healthy = await status();
  assert.equal(healthy.code, 200);
  assert.equal(healthy.body.healthy, true, JSON.stringify(healthy.body));
  assert.deepEqual(healthy.body.failures, []);
  assert.ok(Number(healthy.body.alarmAtMs) > fired);
  for (const name of [
    "stale_session_reservations",
    "stale_provider_requests",
    "billing_events_pending_5m",
    "provider_operations_failed_5m",
    "negative_allowances",
    "reasoning_http_errors_5m",
    "transcription_provider_failures_5m",
    "billing_retries_5m",
    "reconcile_failures_5m",
  ])
    assert.equal(healthy.body[name], 0, name);
  await sql(
    "INSERT INTO accounts(issuer,subject,created_at_ms) VALUES('status','stale',0)",
  );
  const leased = Date.now() + 600_000;
  const lapsed = Date.now() - 120_000;
  await sql(
    `WITH v(local,state,reserved,lease) AS (VALUES ('paused-held','paused',1000,${leased}),('stopped-held','stopped',500,${leased}),('lapsed','active',1000,${lapsed}),('paused-clear','paused',0,${leased}),('live','active',1000,${leased})) INSERT INTO managed_sessions(account_id,local_session_id,state,reserved_ms,lease_expires_ms,created_at_ms,updated_at_ms) SELECT id,local,v.state,reserved,lease,0,0 FROM accounts, v WHERE subject='stale'`,
  );
  try {
    const stale = await status();
    assert.equal(stale.body.healthy, false);
    assert.equal(stale.body.stale_session_reservations, 3);
    assert.deepEqual(stale.body.failures, ["stale_session_reservations"]);
    assert.doesNotMatch(JSON.stringify(stale.body), /stale"|status"/);
  } finally {
    await sql(
      "DELETE FROM managed_sessions WHERE account_id=(SELECT id FROM accounts WHERE subject='stale')",
    );
    await sql("DELETE FROM accounts WHERE subject='stale'");
  }
});

test("unknown paths and audio without an upgrade get 404", async () => {
  assert.equal((await server.fetch("/nope")).status, 404);
  assert.equal((await server.fetch("/v1/nope")).status, 404);
  const audio =
    "/v1/sessions/00000000-0000-4000-8000-000000000001/audio/system";
  assert.equal((await server.fetch(audio)).status, 404);
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
