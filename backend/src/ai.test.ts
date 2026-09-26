import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { openServiceDatabase, type Db } from "./db.js";
import { createAuthorizer, type Authorizer } from "./authorize.js";
import { ServiceState } from "./state.js";
import { configuration } from "./config.js";
import { ApiError } from "./errors.js";
import { insertGrant, balance } from "./billing.js";
import { managedRequest } from "./api.js";
import { reconcile } from "./stripe.js";
import { completeRequest } from "./advice.js";
import {
  createSession,
  onAudio,
  requireSession,
  recoverRestart,
  detachSource,
  attachSource,
  healthyAudio,
} from "./sessions.js";
import {
  briefRequest,
  briefPrompt,
  contracts,
  validateAdvice,
  adviceRequest as adviceRequestSchema,
} from "./context.js";

const SESSION = "00000000-0000-0000-0000-000000000001",
  SOURCE = "00000000-0000-0000-0000-000000000002",
  TURN = "00000000-0000-0000-0000-000000000003";
const request = {
  clientName: "Synthetic client",
  instructions: "Prepare a meeting",
  guidance: [],
  clientEvidence: [
    {
      sourceId: SOURCE,
      relativePath: "notes.md",
      locator: { label: "Notes" },
      text: "June launch",
    },
  ],
};
const brief = {
  title: "Launch",
  objective: "Agree scope",
  responseLanguage: "English",
  ourPosition: "Ready",
  clientPosition: "Needs scope",
  priorities: [],
  agenda: [
    { title: "Scope", objective: "Agree", talkingPoints: [], keywords: [] },
  ],
  desiredOutcomes: [],
  questionsToAsk: [],
  factsToUse: [{ statement: "June launch", sourceIds: [SOURCE] }],
  concessions: [],
  redLines: [],
  prohibitedClaims: [],
  unauthorizedCommitments: [],
  risks: [],
};
const adviceRequest = {
  sessionId: SESSION,
  generationId: 1,
  transcriptRevision: 1,
  trigger: "manual",
  language: "English",
  briefMarkdown: "# Launch",
  hardConstraints: [],
  evidence: [
    {
      id: SOURCE,
      kind: "client",
      relativePath: "notes.md",
      locator: { label: "Notes" },
      excerpt: "June launch",
    },
  ],
  meetingLedger: { items: [] },
  recentTurns: [
    {
      id: TURN,
      sessionId: SESSION,
      channel: "other",
      text: "Can we launch in June?",
      language: "English",
      startMs: 0,
      endMs: 1000,
      isFinal: true,
      confidence: 0.99,
    },
  ],
  focalTurnIds: [TURN],
};
const advice = {
  action: "show",
  say: "Which scope is essential for June?",
  avoid: "",
  rationale: "Clarify scope",
  language: "English",
  evidenceIds: [SOURCE],
  turnIds: [TURN],
  memoryUpdates: [],
  validForMs: 30_000,
};
async function fixture(
  t: TestContext,
  options: {
    env?: NodeJS.ProcessEnv;
    authorizer?: (db: Db, clock: () => bigint) => Authorizer;
  } = {},
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let output: unknown = brief;
  let status = 200;
  let tokenCount = 100;
  let countGate: (() => Promise<void>) | undefined;
  let generationGate: (() => Promise<void>) | undefined;
  let rawText: string | undefined;
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    calls.push({ path: req.url!, body });
    assert.equal(req.headers["x-api-key"], "synthetic");
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    if (req.url?.endsWith("count_tokens")) await countGate?.();
    else await generationGate?.();
    res.writeHead(req.url?.endsWith("count_tokens") ? 200 : status, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify(
        req.url?.endsWith("count_tokens")
          ? { input_tokens: tokenCount }
          : {
              id: "vendor_test",
              usage: { input_tokens: 10, output_tokens: 20 },
              stop_reason: "end_turn",
              content: [
                { type: "text", text: rawText ?? JSON.stringify(output) },
              ],
            },
      ),
    );
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const db = openServiceDatabase(":memory:");
  let now = 1_700_000_000_000n;
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','a',0),(2,'issuer','b',0)",
  ).run();
  db.transaction(() =>
    insertGrant(db, 1n, "pack", "pack", 10_800_000n, 20n, now, null),
  ).immediate();
  const state = new ServiceState(
    configuration({
      SAVVY_STRIPE_SECRET_KEY: "synthetic",
      SAVVY_STRIPE_WEBHOOK_SECRET: "synthetic",
      SAVVY_STRIPE_PRICE_MONTHLY: "price_monthly",
      SAVVY_STRIPE_PRICE_PACK: "price_pack",
      SAVVY_ANTHROPIC_API_KEY: "synthetic",
      SAVVY_ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      SAVVY_DEEPGRAM_API_KEY: "synthetic",
      ...options.env,
    }),
    db,
    () => now,
    options.authorizer?.(db, () => now) ??
      (async (headers) => {
        if (!["Bearer a", "Bearer b"].includes(headers.authorization ?? ""))
          throw new ApiError("sign_in_required", "missing test token");
        return {
          accountId: headers.authorization === "Bearer a" ? 1n : 2n,
          subject: "test",
          expiresAtMs: now + 60_000n,
          displayIdentity: {
            issuer: "issuer",
            subject: "test",
            name: null,
            email: null,
            emailVerified: false,
          },
        };
      }),
  );
  const server = createServer((req, res) => {
    void managedRequest(
      state,
      req,
      res,
      new URL(req.url!, "http://localhost").pathname,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiAddress = server.address();
  assert.ok(apiAddress && typeof apiAddress !== "string");
  const base = `http://127.0.0.1:${apiAddress.port}`;
  t.after(async () => {
    for (const listener of [server, provider]) {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    db.close();
  });
  const post = async (path: string, body: unknown, account = "a") => {
    const result = await fetch(base + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${account}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: result.status, body: await result.json() };
  };
  const audio = (id = SESSION) => {
    for (let i = 0; i < 10; i++) {
      onAudio(state, 1n, id, "microphone", 16_000, now);
      now += 500n;
    }
  };
  return {
    audio,
    state,
    db,
    calls,
    post,
    base,
    setOutput(value: unknown) {
      output = value;
    },
    setStatus(value: number) {
      status = value;
    },
    setCount(value: number) {
      tokenCount = value;
    },
    gate(fn: () => Promise<void>) {
      countGate = fn;
    },
    generationGate(fn: () => Promise<void>) {
      generationGate = fn;
    },
    setRawText(value: string) {
      rawText = value;
    },
    advance(ms: bigint) {
      now += ms;
    },
    live() {
      db.transaction(() => createSession(db, 1n, SESSION, now)).immediate();
      audio();
    },
  };
}

test("provider advice bounds reject oversized text and repeated citations before delivery", async (t) => {
  const input = adviceRequestSchema.parse(adviceRequest);
  assert.doesNotThrow(() => validateAdvice(advice, input));
  for (const invalid of [
    { ...advice, say: "x".repeat(100000) },
    { ...advice, avoid: "😀".repeat(513) },
    { ...advice, evidenceIds: [SOURCE, SOURCE] },
    {
      ...advice,
      memoryUpdates: Array(9).fill({
        kind: "decision",
        text: "fact",
        sourceTurnIds: [TURN],
      }),
    },
    {
      ...advice,
      memoryUpdates: [
        { kind: "decision", text: "fact", sourceTurnIds: [TURN, TURN] },
      ],
    },
  ])
    assert.throws(() => validateAdvice(invalid, input), /output limits/);
  const h = await fixture(t);
  h.live();
  h.setOutput({ ...advice, say: "x".repeat(100000) });
  const result = await h.post(`/v1/sessions/${SESSION}/recommendations`, {
    idempotencyKey: "oversized",
    leaseVersion: 1,
    request: adviceRequest,
  });
  assert.equal(result.status, 410);
  assert.equal(result.body.code, "result_unavailable");
  assert.equal(h.state.aiInFlight.size, 0);
});

test("tiny keepalives cannot authorize paid advice but sustained audio can", async (t) => {
  const h = await fixture(t);
  h.setOutput(advice);
  h.db
    .transaction(() => createSession(h.db, 1n, SESSION, h.state.clock()))
    .immediate();
  const body = {
    idempotencyKey: "audio-readiness",
    leaseVersion: 1,
    request: adviceRequest,
  };
  const path = `/v1/sessions/${SESSION}/recommendations`;
  for (let i = 0; i < 30; i++) {
    onAudio(h.state, 1n, SESSION, "microphone", 2, h.state.clock());
    assert.equal((await h.post(path, body)).status, 409);
    h.advance(4000n);
  }
  assert.equal(h.calls.length, 0);
  h.audio();
  assert.equal((await h.post(path, body)).status, 200);
  assert.equal(h.calls.length, 2); // Token count and one generation.
});

test("brief generation debits once, caches briefly and isolates accounts before supplier calls", async (t) => {
  const h = await fixture(t),
    body = { idempotencyKey: "one", request };
  assert.equal((await h.post("/v1/briefs", body, "invalid")).status, 401);
  assert.equal((await h.post("/v1/briefs", body, "b")).status, 402);
  assert.equal(h.calls.length, 0);
  const result = await h.post("/v1/briefs", body);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { brief });
  assert.deepEqual(await h.post("/v1/briefs", body), result);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT count(*) AS n FROM usage_events WHERE kind='debit_brief'",
      )
      .get(),
    { n: 1n },
  );
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 19n);
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsReserved, 0n);
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT input_tokens,output_tokens,cost_microdollars,state FROM provider_requests WHERE account_id=1",
      )
      .get(),
    {
      input_tokens: 10n,
      output_tokens: 20n,
      cost_microdollars: 220n,
      state: "succeeded",
    },
  );
  const sent = h.calls[0].body.messages as { content: string }[];
  assert.equal(sent[0].content, briefPrompt(briefRequest.parse(request)));
  assert.equal(h.calls[1].body.max_tokens, 4096);
  h.advance(300_001n);
  assert.equal((await h.post("/v1/briefs", body)).status, 410);
  assert.equal(h.calls.length, 2);
});

test("cancel during token counting aborts dispatch, releases allowance and cannot be retried silently", async (t) => {
  const h = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.gate(async () => {
    entered();
    await blocked;
  });
  const response = h.post("/v1/briefs", {
    idempotencyKey: "cancel_me",
    request,
  });
  await started;
  try {
    assert.equal(
      (await h.post("/v1/requests/cancel_me/cancel", {})).status,
      200,
    );
    assert.equal((await response).status, 410);
    assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 20n);
    assert.equal(balance(h.db, 1n, h.state.clock()).briefsReserved, 0n);
    assert.equal(h.calls.length, 1);
    assert.equal(h.state.aiHealth.failures.length, 0);
    assert.equal(
      (await h.post("/v1/briefs", { idempotencyKey: "cancel_me", request }))
        .status,
      410,
    );
    assert.equal(h.state.aiInFlight.size, 0);
    assert.equal(h.state.cancellations.size, 0);
  } finally {
    release();
  }
});

test("rejected grounding and excessive context release reservations without opening the outage circuit", async (t) => {
  const h = await fixture(t);
  h.live();
  h.setOutput({
    ...brief,
    factsToUse: [{ statement: "Invented", sourceIds: [TURN] }],
  });
  assert.equal(
    (await h.post("/v1/briefs", { idempotencyKey: "bad", request })).status,
    410,
  );
  assert.deepEqual(
    h.db
      .prepare("SELECT input_tokens,output_tokens,state FROM provider_requests")
      .get(),
    { input_tokens: 10n, output_tokens: 20n, state: "failed" },
  );
  assert.equal(requireSession(h.db, 1n, SESSION).state, "active");
  assert.equal(h.state.aiHealth.failures.length, 0);
  h.setCount(120001);
  assert.equal(
    (await h.post("/v1/briefs", { idempotencyKey: "large", request })).status,
    413,
  );
  assert.equal(h.calls.filter((c) => c.path === "/v1/messages").length, 1);
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 20n);
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsReserved, 0n);
});

test("supplier failures pause sessions, shared cooldown probes contain no customer context and never resume listening", async (t) => {
  const h = await fixture(t);
  h.live();
  h.db
    .transaction(() => {
      insertGrant(
        h.db,
        2n,
        "other_pack",
        "pack",
        10_800_000n,
        6n,
        h.state.clock(),
        null,
      );
      createSession(h.db, 2n, SOURCE, h.state.clock());
    })
    .immediate();
  h.setStatus(503);
  for (let i = 0; i < 3; i++)
    assert.equal(
      (await h.post("/v1/briefs", { idempotencyKey: `fail_${i}`, request }))
        .status,
      503,
    );
  assert.equal(requireSession(h.db, 1n, SESSION).state, "paused");
  assert.equal(h.state.aiPaused, true);
  assert.equal(requireSession(h.db, 2n, SOURCE).state, "paused");
  const charged = requireSession(h.db, 1n, SESSION).settled_ms;
  const before = h.calls.length;
  h.advance(20_000n);
  assert.equal(
    (await h.post("/v1/briefs", { idempotencyKey: "cooldown", request }))
      .status,
    503,
  );
  assert.equal(h.calls.length, before);
  assert.equal(requireSession(h.db, 1n, SESSION).settled_ms, charged);
  h.advance(10_000n);
  h.setStatus(200);
  assert.equal(
    (await h.post("/v1/briefs", { idempotencyKey: "recovered", request }))
      .status,
    200,
  );
  const probe = h.calls.find((c) => c.body.max_tokens === 16)!;
  assert.deepEqual(probe.body.messages, [
    { role: "user", content: "Reply with OK." },
  ]);
  assert.equal(JSON.stringify(probe.body).includes("Synthetic client"), false);
  assert.equal(h.state.aiPaused, false);
  assert.equal(requireSession(h.db, 1n, SESSION).settled_ms, charged);
  assert.equal(requireSession(h.db, 2n, SOURCE).state, "paused");
  assert.equal(requireSession(h.db, 1n, SESSION).state, "paused");
});

test("live advice requires healthy audio and enforces language, duplicate and pacing limits", async (t) => {
  const h = await fixture(t);
  h.setOutput(advice);
  h.db
    .transaction(() => createSession(h.db, 1n, SESSION, h.state.clock()))
    .immediate();
  const body = {
    idempotencyKey: "advice_one",
    leaseVersion: 1,
    request: adviceRequest,
  };
  const path = `/v1/sessions/${SESSION}/recommendations`;
  assert.equal((await h.post(path, body)).status, 409);
  assert.equal(h.calls.length, 0);
  h.audio();
  const response = await h.post(path, body);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    advice,
    sessionId: SESSION,
    generationId: 1,
    transcriptRevision: 1,
  });
  assert.equal((await h.post(path, body)).status, 410);
  const tooSoon = await h.post(path, {
    ...body,
    idempotencyKey: "too_soon",
  });
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.body.retryAfterMs, 5000);
  h.advance(5000n);
  h.audio();
  const automatic = await h.post(path, {
    ...body,
    idempotencyKey: "automatic",
    request: { ...adviceRequest, trigger: "question" },
  });
  assert.equal(automatic.status, 200);
  h.advance(5000n);
  h.audio();
  h.setOutput({ ...advice, language: "Spanish" });
  assert.equal(
    (await h.post(path, { ...body, idempotencyKey: "wrong_language" })).status,
    410,
  );
  assert.equal(h.state.aiHealth.failures.length, 0);
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT input_tokens,output_tokens,state FROM provider_requests WHERE request_key='wrong_language'",
      )
      .get(),
    { input_tokens: 10n, output_tokens: 20n, state: "failed" },
  );
  assert.equal(requireSession(h.db, 1n, SESSION).state, "active");
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 20n);
  const callsBeforeDetach = h.calls.length;
  detachSource(h.state, requireSession(h.db, 1n, SESSION).id, "microphone", 0n);
  assert.equal(
    (await h.post(path, { ...body, idempotencyKey: "disconnected" })).status,
    409,
  );
  assert.equal(h.calls.length, callsBeforeDetach);
});

test("stale, sparse and disconnected audio cannot dispatch paid advice", async (t) => {
  const h = await fixture(t);
  h.setOutput(advice);
  const row = h.db
    .transaction(() => createSession(h.db, 1n, SESSION, h.state.clock()))
    .immediate();
  const old = attachSource(h.state, row, "microphone", h.state.clock());
  const current = attachSource(h.state, row, "microphone", h.state.clock());
  assert.throws(
    () =>
      onAudio(h.state, 1n, SESSION, "microphone", 3200, h.state.clock(), {
        version: 1n,
        generation: old,
      }),
    { code: "session_conflict" },
  );
  assert.equal(healthyAudio(h.state, row.id, h.state.clock()), false);
  assert.equal(requireSession(h.db, 1n, SESSION).settled_ms, 0n);
  onAudio(h.state, 1n, SESSION, "microphone", 3200, h.state.clock(), {
    version: 1n,
    generation: current,
  });
  const path = `/v1/sessions/${SESSION}/recommendations`;
  const body = { leaseVersion: 1, request: adviceRequest };
  assert.equal(
    (await h.post(path, { ...body, idempotencyKey: "sparse" })).status,
    409,
  );
  assert.equal(h.calls.length, 0);
  h.advance(100n);
  h.audio();
  assert.equal(healthyAudio(h.state, row.id, h.state.clock()), true);
  detachSource(h.state, row.id, "microphone", current);
  assert.equal(healthyAudio(h.state, row.id, h.state.clock()), false);
  assert.equal(
    (await h.post(path, { ...body, idempotencyKey: "disconnected" })).status,
    409,
  );
  assert.equal(h.calls.length, 0);
});

test("wire schemas and prompt assets retain the baseline contract and forbid absolute evidence paths", async (t) => {
  const h = await fixture(t);
  assert.equal(
    (
      await h.post("/v1/briefs", {
        idempotencyKey: "path",
        request: {
          ...request,
          clientEvidence: [
            { ...request.clientEvidence[0], relativePath: "/private/notes.md" },
          ],
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.post("/v1/briefs", {
        idempotencyKey: "shape",
        request: { ...request, guidance: "invalid" },
      })
    ).status,
    422,
  );
  assert.equal(h.calls.length, 0);
  assert.deepEqual(
    [...(contracts.briefSchema.required as string[])].sort(),
    Object.keys(brief).sort(),
  );
});

test("disconnecting the real HTTP request cancels supplier work and releases its reservation", async (t) => {
  const h = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.gate(async () => {
    entered();
    await blocked;
  });
  const controller = new AbortController();
  const response = fetch(h.base + "/v1/briefs", {
    method: "POST",
    headers: { authorization: "Bearer a", "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "disconnect", request }),
    signal: controller.signal,
  });
  await started;
  try {
    controller.abort();
    await assert.rejects(response, { name: "AbortError" });
    for (let i = 0; i < 200 && h.state.aiInFlight.size; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.state.aiInFlight.size, 0);
    assert.equal(h.state.cancellations.size, 0);
    assert.equal(balance(h.db, 1n, h.state.clock()).briefsReserved, 0n);
    assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 20n);
    assert.equal(h.calls.length, 1);
    assert.equal(
      (await h.post("/v1/briefs", { idempotencyKey: "disconnect", request }))
        .status,
      410,
    );
  } finally {
    release();
  }
});

test("shared provider schemas remain identical to the retained desktop source", () => {
  const source = readFileSync(
    new URL("../../crates/providers/src/lib.rs", import.meta.url),
    "utf8",
  );
  for (const [name, schema] of [
    ["BRIEF_OUTPUT_SCHEMA", contracts.briefSchema],
    ["PROVIDER_OUTPUT_SCHEMA", contracts.adviceSchema],
  ] as const) {
    const match = new RegExp(
      `pub const ${name}: &str = r#"([\\s\\S]*?)"#;`,
    ).exec(source);
    assert.ok(match);
    assert.deepEqual(JSON.parse(match[1]), schema);
  }
});

test("drain during an outage probe cannot admit a late advice request", async (t) => {
  const h = await fixture(t);
  h.live();
  let release!: () => void;
  h.state.aiHealth.blockedUntil = h.state.clock() - 1n;
  h.state.aiHealth.probe = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = h.post(`/v1/sessions/${SESSION}/recommendations`, {
    idempotencyKey: "late",
    leaseVersion: 1,
    request: adviceRequest,
  });
  try {
    for (let i = 0; i < 200 && !h.state.aiInFlight.size; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.state.aiInFlight.size, 1);
    h.state.draining = true;
    release();
    assert.equal((await pending).status, 503);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(
      h.db
        .prepare<[], { n: bigint }>(
          "SELECT count(*) AS n FROM provider_requests",
        )
        .get(),
      { n: 0n },
    );
    assert.equal(h.state.aiHealth.failures.length, 0);
  } finally {
    release();
  }
});

function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await blocked;
    },
  };
}

test("racing HTTP requests for the last brief dispatch once and monthly allowance is spent before packs", async (t) => {
  const h = await fixture(t);
  h.db.prepare("UPDATE allowance_grants SET briefs_total=1").run();
  const gate = barrier();
  h.generationGate(gate.wait);
  const first = h.post("/v1/briefs", { idempotencyKey: "winner", request });
  await gate.entered;
  try {
    assert.equal(balance(h.db, 1n, h.state.clock()).briefsReserved, 1n);
    assert.equal(
      (await h.post("/v1/briefs", { idempotencyKey: "loser", request })).status,
      409,
    );
  } finally {
    gate.release();
  }
  assert.equal((await first).status, 200);
  assert.equal(
    (await h.post("/v1/briefs", { idempotencyKey: "empty", request })).status,
    402,
  );
  assert.equal(h.calls.filter((c) => c.path === "/v1/messages").length, 1);
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 0n);
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsReserved, 0n);
  h.db
    .transaction(() => {
      insertGrant(
        h.db,
        1n,
        "second_pack",
        "pack",
        0n,
        1n,
        h.state.clock(),
        null,
      );
      insertGrant(
        h.db,
        1n,
        "monthly",
        "monthly",
        0n,
        1n,
        h.state.clock(),
        h.state.clock() + 1000n,
      );
    })
    .immediate();
  assert.equal(
    (await h.post("/v1/briefs", { idempotencyKey: "monthly_first", request }))
      .status,
    200,
  );
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT origin,briefs_used FROM allowance_grants WHERE origin<>'pack' ORDER BY origin",
      )
      .all(),
    [
      { origin: "monthly", briefs_used: 1n },
      { origin: "second_pack", briefs_used: 0n },
    ],
  );
});

test("failed generation and invalid JSON release allowance, retain typed errors and never redispatch a failed key", async (t) => {
  const h = await fixture(t);
  h.setStatus(500);
  const failed = await h.post("/v1/briefs", {
    idempotencyKey: "failed",
    request,
  });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "provider_unavailable");
  assert.equal(JSON.stringify(failed.body).includes("vendor_test"), false);
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 20n);
  h.setStatus(200);
  assert.equal(
    (await h.post("/v1/briefs", { idempotencyKey: "failed", request })).status,
    410,
  );
  assert.equal(
    (await h.post("/v1/briefs", { idempotencyKey: "fresh", request })).status,
    200,
  );
  h.setRawText("{not json");
  assert.equal(
    (await h.post("/v1/briefs", { idempotencyKey: "invalid_json", request }))
      .status,
    410,
  );
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 19n);
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsReserved, 0n);
  assert.equal(h.state.aiHealth.failures.length, 0);
});

test("pre-cancellation and cancellation at completion preserve durable failure and refund cannot settle a brief", async (t) => {
  const h = await fixture(t);
  assert.equal(
    (await h.post("/v1/requests/pre_canceled/cancel", {})).status,
    200,
  );
  assert.equal(
    (await h.post("/v1/briefs", { idempotencyKey: "pre_canceled", request }))
      .status,
    410,
  );
  assert.equal(h.calls.length, 0);
  h.live();
  h.db
    .prepare(
      "INSERT INTO provider_requests(account_id,request_key,operation,state,created_at_ms) VALUES(1,'finishing','advice','pending',?)",
    )
    .run(h.state.clock());
  assert.equal((await h.post("/v1/requests/finishing/cancel", {})).status, 200);
  assert.throws(
    () =>
      h.db
        .transaction(() =>
          completeRequest(
            h.state,
            1n,
            SESSION,
            1n,
            "finishing",
            h.state.clock(),
          ),
        )
        .immediate(),
    { code: "result_unavailable" },
  );
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT state FROM provider_requests WHERE request_key='finishing'",
      )
      .get(),
    { state: "failed" },
  );
  const gate = barrier();
  h.generationGate(gate.wait);
  const pending = h.post("/v1/briefs", { idempotencyKey: "refunded", request });
  await gate.entered;
  h.db.prepare("UPDATE allowance_grants SET revoked=1").run();
  gate.release();
  assert.equal((await pending).status, 402);
  assert.deepEqual(
    h.db
      .prepare("SELECT briefs_used,briefs_reserved FROM allowance_grants")
      .get(),
    { briefs_used: 0n, briefs_reserved: 0n },
  );
  assert.equal(h.state.aiInFlight.size, 0);
});

test("120 automatic skips count toward the hourly limit and a modified-client flood cannot dispatch more", async (t) => {
  const h = await fixture(t);
  const started = h.state.clock();
  h.live();
  h.setOutput({
    ...advice,
    action: "skip",
    say: "",
    rationale: "No new action",
    evidenceIds: [],
    turnIds: [],
  });
  const path = `/v1/sessions/${SESSION}/recommendations`;
  for (let i = 0; i < 120; i++) {
    if (i) h.advance(5500n);
    h.audio();
    const result = await h.post(path, {
      idempotencyKey: `skip_${i}`,
      leaseVersion: 1,
      request: { ...adviceRequest, trigger: "opportunity" },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.advice.action, "skip");
  }
  h.advance(5500n);
  h.audio();
  for (let i = 0; i < 100; i++) {
    const result = await h.post(path, {
      idempotencyKey: `flood_${i}`,
      leaseVersion: 1,
      request: { ...adviceRequest, trigger: "question" },
    });
    assert.equal(result.status, 429, JSON.stringify(result.body));
    assert.ok(
      result.body.retryAfterMs > 0 && result.body.retryAfterMs < 3_600_000,
    );
  }
  assert.equal(h.calls.filter((c) => c.path === "/v1/messages").length, 120);
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT count(*) AS n,sum(input_tokens) AS input FROM provider_requests WHERE operation='advice'",
      )
      .get(),
    { n: 120n, input: 1200n },
  );
  assert.ok(
    requireSession(h.db, 1n, SESSION).settled_ms <= h.state.clock() - started,
  );
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 20n);
});

test("selected private context reaches the supplier but only usage metadata reaches durable tables", async (t) => {
  const h = await fixture(t);
  const sentinel = "PRIVATE_CONTEXT_SENTINEL_47d5d780";
  assert.equal(
    (
      await h.post("/v1/briefs", {
        idempotencyKey: "privacy",
        request: {
          ...request,
          clientEvidence: [{ ...request.clientEvidence[0], text: sentinel }],
          document_path: "/Users/private/hidden",
          unselectedText: "UNSELECTED_SECRET",
        },
      })
    ).status,
    200,
  );
  const wire = JSON.stringify(h.calls);
  assert.ok(wire.includes(sentinel));
  for (const value of [
    "/Users/",
    "document_path",
    "UNSELECTED_SECRET",
    "Bearer a",
  ])
    assert.equal(wire.includes(value), false, value);
  const tables = h.db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'",
    )
    .all();
  const dump = JSON.stringify(
    tables.map(({ name }) =>
      h.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    ),
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  for (const value of [
    sentinel,
    brief.title,
    "Bearer a",
    "/Users/",
    "UNSELECTED_SECRET",
  ])
    assert.equal(dump.includes(value), false, value);
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT input_tokens,output_tokens FROM provider_requests WHERE request_key='privacy'",
      )
      .get(),
    { input_tokens: 10n, output_tokens: 20n },
  );
});

test(
  "stalled brief and advice stop at their actual outer deadlines and release allowance",
  { timeout: 140_000 },
  async (t) => {
    await Promise.all(
      [true, false].map(async (isBrief) => {
        const h = await fixture(t);
        h.live();
        const gate = barrier();
        h.generationGate(gate.wait);
        const began = performance.now();
        const pending = isBrief
          ? h.post("/v1/briefs", { idempotencyKey: "deadline", request })
          : h.post(`/v1/sessions/${SESSION}/recommendations`, {
              idempotencyKey: "deadline",
              leaseVersion: 1,
              request: adviceRequest,
            });
        await gate.entered;
        try {
          const result = await pending;
          const elapsed = performance.now() - began;
          const deadline = isBrief ? 120_000 : 30_000;
          assert.equal(result.status, 503, JSON.stringify(result.body));
          assert.equal(result.body.code, "provider_unavailable");
          assert.ok(
            elapsed >= deadline - 500 && elapsed < deadline + 5000,
            `deadline ${deadline}, elapsed ${elapsed}`,
          );
          assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 20n);
          assert.equal(balance(h.db, 1n, h.state.clock()).briefsReserved, 0n);
          assert.equal(h.state.aiInFlight.size, 0);
          assert.equal(h.state.cancellations.size, 0);
          assert.equal(requireSession(h.db, 1n, SESSION).state, "paused");
          assert.deepEqual(
            h.db
              .prepare(
                "SELECT state FROM provider_requests WHERE request_key='deadline'",
              )
              .get(),
            { state: "failed" },
          );
        } finally {
          gate.release();
        }
      }),
    );
  },
);

test("thirty synthetic meetings preserve multilingual opportunity citations and response contracts", async (t) => {
  const h = await fixture(t);
  const corpus = JSON.parse(
    readFileSync(
      new URL(
        "../../tests/fixtures/recommendations/opportunity.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    id: string;
    language: string;
    expectedAction: string;
    turns: { channel: string; text: string; startMs: number; endMs: number }[];
  }[];
  assert.equal(corpus.length, 30);
  const latencies: number[] = [];
  const uuid = (id: number) =>
    `00000000-0000-0000-0000-${id.toString(16).padStart(12, "0")}`;
  for (const [i, sample] of corpus.entries()) {
    const id = uuid(1000 + i);
    assert.equal((await h.post("/v1/sessions", { sessionId: id })).status, 200);
    h.audio(id);
    const turns = sample.turns.map((turn, j) => ({
      ...turn,
      id: uuid(100_000 + i * 100 + j),
      sessionId: id,
      language: sample.language,
      isFinal: true,
      confidence: 0.99,
    }));
    const focal = turns.at(-1)!.id;
    h.setOutput({
      ...advice,
      action: sample.expectedAction,
      language: sample.language,
      say: sample.expectedAction === "show" ? "Synthetic response" : "",
      turnIds: sample.expectedAction === "show" ? [focal] : [],
    });
    const began = performance.now();
    const result = await h.post(`/v1/sessions/${id}/recommendations`, {
      idempotencyKey: `corpus_${i}`,
      leaseVersion: 1,
      request: {
        ...adviceRequest,
        sessionId: id,
        language: sample.language,
        briefMarkdown: sample.id,
        trigger: "opportunity",
        recentTurns: turns,
        focalTurnIds: [focal],
      },
    });
    latencies.push(performance.now() - began);
    assert.equal(
      result.status,
      200,
      `${sample.id}: ${JSON.stringify(result.body)}`,
    );
    assert.equal(result.body.advice.action, sample.expectedAction);
    assert.equal(result.body.advice.language, sample.language);
    if (sample.expectedAction === "show")
      assert.deepEqual(result.body.advice.turnIds, [focal]);
    h.advance(20n);
    assert.equal(
      (
        await h.post(`/v1/sessions/${id}/stop`, {
          leaseVersion: 1,
          commandId: 1,
        })
      ).status,
      200,
    );
    h.advance(5500n);
  }
  assert.equal(h.calls.filter((c) => c.path === "/v1/messages").length, 30);
  latencies.sort((a, b) => a - b);
  assert.ok(latencies[28] < 8000);
  t.diagnostic(
    `Synthetic supplier transport only: n=30 p50=${latencies[15].toFixed(1)}ms p95=${latencies[28].toFixed(1)}ms`,
  );
});

test("generation disconnect and cancellation abort paid work after dispatch and oversized input never generates", async (t) => {
  const h = await fixture(t);
  const gate = barrier();
  h.generationGate(gate.wait);
  const controller = new AbortController();
  const response = fetch(h.base + "/v1/briefs", {
    method: "POST",
    headers: { authorization: "Bearer a", "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "generation_disconnect", request }),
    signal: controller.signal,
  });
  await gate.entered;
  try {
    controller.abort();
    await assert.rejects(response, { name: "AbortError" });
    for (let i = 0; i < 200 && h.state.aiInFlight.size; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.state.aiInFlight.size, 0);
    assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 20n);
    assert.equal(balance(h.db, 1n, h.state.clock()).briefsReserved, 0n);
    assert.equal(
      (
        await h.post("/v1/briefs", {
          idempotencyKey: "generation_disconnect",
          request,
        })
      ).status,
      410,
    );
    assert.equal(h.calls.filter((c) => c.path === "/v1/messages").length, 1);
  } finally {
    gate.release();
  }
  h.setCount(233_334);
  const result = await h.post("/v1/briefs", {
    idempotencyKey: "huge",
    request: { ...request, instructions: "x".repeat(700_000) },
  });
  assert.equal(result.status, 413);
  assert.equal(result.body.code, "context_too_large");
  assert.equal(h.calls.filter((c) => c.path === "/v1/messages").length, 1);
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsReserved, 0n);
});

test("two devices racing for the final seconds reserve once through HTTP and foreign lifecycle calls cannot spend", async (t) => {
  const h = await fixture(t);
  h.db.prepare("UPDATE allowance_grants SET meeting_ms_total=500").run();
  const responses = await Promise.all(
    [SESSION, SOURCE].map((sessionId) => h.post("/v1/sessions", { sessionId })),
  );
  assert.equal(responses.filter((r) => r.status === 200).length, 1);
  const id = responses[0].status === 200 ? SESSION : SOURCE;
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 500n);
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsAvailable, 0n);
  for (const action of ["pause", "resume", "stop"])
    assert.equal(
      (
        await h.post(
          `/v1/sessions/${id}/${action}`,
          { leaseVersion: 1, commandId: 1 },
          "b",
        )
      ).status,
      409,
    );
  onAudio(h.state, 1n, id, "microphone", 16_000, h.state.clock());
  h.advance(500n);
  assert.equal(
    onAudio(h.state, 1n, id, "microphone", 16_000, h.state.clock()),
    "exhausted",
  );
  assert.equal(requireSession(h.db, 1n, id).settled_ms, 500n);
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 0n);
  assert.equal(h.calls.length, 0);
});

test("invalid output and cancellation floods hit durable attempt ceilings, and expired leases cannot complete advice", async (t) => {
  const h = await fixture(t);
  h.setRawText("{invalid");
  for (let i = 0; i < 6; i++)
    assert.equal(
      (await h.post("/v1/briefs", { idempotencyKey: `bad_${i}`, request }))
        .status,
      410,
    );
  assert.equal(
    (await h.post("/v1/briefs", { idempotencyKey: "blocked", request })).status,
    429,
  );
  assert.equal(h.state.aiPaused, false);
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 20n);
  for (let i = 0; i < 60; i++)
    assert.equal(
      (await h.post(`/v1/requests/cancel_${i}/cancel`, {})).status,
      200,
    );
  assert.equal(
    (await h.post("/v1/requests/cancel_over/cancel", {})).status,
    429,
  );
  assert.deepEqual(
    h.db.prepare("SELECT count(*) AS n FROM cancellation_tombstones").get(),
    { n: 60n },
  );
  h.live();
  h.db
    .prepare(
      "INSERT INTO provider_requests(account_id,request_key,operation,state,created_at_ms) VALUES(1,'late','advice','pending',?)",
    )
    .run(h.state.clock());
  h.advance(30_001n);
  assert.throws(
    () =>
      h.db
        .transaction(() =>
          completeRequest(h.state, 1n, SESSION, 1n, "late", h.state.clock()),
        )
        .immediate(),
    { code: "result_unavailable" },
  );
});

test("draining refuses new sessions, briefs and checkout while releasing reservations", async (t) => {
  const h = await fixture(t);
  h.live();
  h.state.draining = true;
  recoverRestart(h.state);
  for (const [path, body] of [
    ["/v1/sessions", { sessionId: SOURCE }],
    ["/v1/briefs", { idempotencyKey: "drain", request }],
    ["/v1/billing/checkout", { product: "pack", idempotencyKey: "drain" }],
  ] as const)
    assert.equal((await h.post(path, body)).status, 503);
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 0n);
  assert.equal(h.calls.length, 0);
  assert.equal((await fetch(h.base + "/readyz")).status, 503);
});

test("meeting context admission counts full source before capture without charging allowance", async (t) => {
  const h = await fixture(t);
  h.db
    .transaction(() => createSession(h.db, 1n, SESSION, h.state.clock()))
    .immediate();
  const before = balance(h.db, 1n, h.state.clock());
  const path = `/v1/sessions/${SESSION}/context`;
  const body = {
    request: { ...adviceRequest, recentTurns: [], focalTurnIds: [] },
  };
  assert.equal((await h.post(path, body, "b")).body.code, "session_conflict");
  assert.equal(h.calls.length, 0);
  h.setCount(16_000);
  assert.deepEqual((await h.post(path, body)).body, {
    ready: true,
    reservedInputTokens: 8_000,
  });
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].path.endsWith("count_tokens"));
  assert.ok(JSON.stringify(h.calls[0].body).includes("# Launch"));
  h.setCount(16_001);
  assert.equal((await h.post(path, body)).body.code, "context_too_large");
  for (const text of ["x".repeat(800_000), "\0".repeat(140_000)]) {
    assert.equal(
      (
        await h.post(path, {
          request: { ...body.request, briefMarkdown: text },
        })
      ).body.code,
      "context_too_large",
    );
  }
  assert.equal(h.calls.length, 2);
  assert.deepEqual(balance(h.db, 1n, h.state.clock()), before);
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM provider_requests")
      .get()!.n,
    0n,
  );
  h.setCount(100);
  for (let i = 0; i < 4; i++)
    assert.equal((await h.post(path, body)).status, 200);
  assert.equal((await h.post(path, body)).body.code, "rate_limited");
  assert.equal(h.state.aiInFlight.size, 0);
});

test("without Stripe, a new account gets an unmetered grant and billing routes refuse", async (t) => {
  let stripeRequests = 0;
  const stripe = createServer((_req, res) => {
    stripeRequests++;
    res.writeHead(500).end();
  });
  stripe.listen(0, "127.0.0.1");
  await once(stripe, "listening");
  t.after(() => new Promise<void>((resolve) => stripe.close(() => resolve())));
  const stripeAddress = stripe.address();
  assert.ok(stripeAddress && typeof stripeAddress !== "string");
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = {
    keys: [{ ...(await exportJWK(publicKey)), kid: "one", alg: "RS256" }],
  };
  const h = await fixture(t, {
    env: {
      SAVVY_STRIPE_SECRET_KEY: "",
      SAVVY_STRIPE_WEBHOOK_SECRET: "",
      SAVVY_STRIPE_PRICE_MONTHLY: "",
      SAVVY_STRIPE_PRICE_PACK: "",
      SAVVY_STRIPE_BASE_URL: `http://127.0.0.1:${stripeAddress.port}`,
    },
    authorizer: (db, clock) =>
      createAuthorizer(
        db,
        { issuer: "issuer", audience: "savvy-tests", unmetered: true },
        async () => keys,
        clock,
      ),
  });
  assert.equal(h.state.config.billing, null);
  const token = await new SignJWT({ sub: "unmetered" })
    .setProtectedHeader({ alg: "RS256", kid: "one" })
    .setIssuer("issuer")
    .setAudience("savvy-tests")
    .setExpirationTime("5m")
    .sign(privateKey);
  const account = await fetch(h.base + "/v1/account", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(account.status, 200);
  const summary = await account.json();
  assert.equal(summary.catalog, null);
  assert.deepEqual(summary.pendingPurchases, []);
  assert.equal(summary.latestConfirmedPurchase, null);
  assert.equal(summary.briefsAvailable, 1_000_000);
  const brief = await h.post(
    "/v1/briefs",
    { idempotencyKey: "unmetered", request },
    token,
  );
  assert.equal(brief.status, 200);
  const session = await h.post("/v1/sessions", { sessionId: SESSION }, token);
  assert.equal(session.status, 200);
  const accountId = BigInt(
    (
      h.db
        .prepare("SELECT id FROM accounts WHERE subject='unmetered'")
        .get() as { id: bigint }
    ).id,
  );
  const totals = balance(h.db, accountId, h.state.clock());
  assert.equal(totals.briefsAvailable, 999_999n);
  assert.ok(totals.meetingMsReserved > 0n);
  await fetch(h.base + "/v1/account", {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.arrayBuffer());
  assert.deepEqual(
    h.db
      .prepare("SELECT COUNT(*) AS n FROM allowance_grants WHERE account_id=?")
      .get(accountId),
    { n: 1n },
  );
  for (const [path, body] of [
    ["/v1/billing/checkout", { product: "pack", idempotencyKey: "u" }],
    ["/v1/billing/portal", {}],
    ["/v1/billing/webhook", {}],
  ] as const) {
    const refused = await h.post(path, body, token);
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, {
      code: "invalid_request",
      message: "billing is not configured on this backend",
    });
  }
  await reconcile(h.state);
  assert.equal(stripeRequests, 0);
  h.state.config.billing = {
    key: "synthetic",
    webhookSecret: "synthetic",
    priceMonthly: "price_monthly",
    pricePack: "price_pack",
  };
  recoverRestart(h.state);
  assert.equal(balance(h.db, accountId, h.state.clock()).briefsAvailable, 0n);
  assert.deepEqual(
    h.db
      .prepare("SELECT revoked FROM allowance_grants WHERE kind='unmetered'")
      .all(),
    [{ revoked: 1n }],
  );
  h.state.config.billing = null;
  recoverRestart(h.state);
  assert.ok(balance(h.db, accountId, h.state.clock()).briefsAvailable > 0n);
});
