import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { openServiceDatabase } from "./db.js";
import { ServiceState } from "./state.js";
import { configuration } from "./config.js";
import { insertGrant, balance } from "./billing.js";
import {
  createSession,
  requireSession,
  sessionView,
  lifecycle,
  onAudio,
  attachSource,
  sourceGeneration,
  detachSource,
  checkAudio,
  settleDisconnectedSource,
  expireStaleSessions,
  recoverRestart,
  onIdleCheck,
  healthyAudio,
  pauseSession,
  validateSessionId,
  type Source,
} from "./sessions.js";

const ID = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
function fixture(t: TestContext, allowance = 36_000_000n) {
  const db = openServiceDatabase(":memory:");
  t.after(() => db.close());
  let now = 1_700_000_000_000n;
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','a',0),(2,'issuer','b',0)",
  ).run();
  const state = new ServiceState(
    configuration({
      SAVVY_STRIPE_SECRET_KEY: "synthetic",
      SAVVY_STRIPE_WEBHOOK_SECRET: "synthetic",
      SAVVY_STRIPE_PRICE_MONTHLY: "price_monthly",
      SAVVY_STRIPE_PRICE_PACK: "price_pack",
      SAVVY_ANTHROPIC_API_KEY: "synthetic",
      SAVVY_DEEPGRAM_API_KEY: "synthetic",
    }),
    db,
    () => now,
    async () => {
      throw new Error("Unused authorizer");
    },
  );
  db.transaction(() =>
    insertGrant(db, 1n, "original", "monthly", allowance, 20n, now, null),
  ).immediate();
  const create = (id = ID, account = 1n) =>
    db.transaction(() => createSession(db, account, id, now)).immediate();
  const advance = (ms: bigint) => {
    now += ms;
  };
  const feed = (
    duration: bigint,
    sources: Source[] = ["microphone"],
    id = ID,
  ) => {
    for (let elapsed = 0n; elapsed < duration; elapsed += 500n) {
      for (const source of sources)
        assert.equal(onAudio(state, 1n, id, source, 16_000, now), "continue");
      advance(500n);
    }
  };
  return {
    db,
    state,
    create,
    advance,
    feed,
    view: () => sessionView(db, 1n, ID, now),
  };
}

test("two simultaneous sources cost 75 seconds across pause/resume and lifecycle replay cannot change state", (t) => {
  const h = fixture(t);
  h.create();
  h.feed(65_000n, ["microphone", "system"]);
  const paused = lifecycle(h.state, 1n, ID, "pause", 1n, 1n);
  assert.equal(paused.settledMs, 65_000n);
  h.advance(20_000n);
  const resumed = lifecycle(h.state, 1n, ID, "resume", 2n, 3n);
  assert.equal(resumed.settledMs, 65_000n);
  const controller = new AbortController();
  h.state.cancellations.set(1n, new Map([["advice", controller]]));
  assert.deepEqual(lifecycle(h.state, 1n, ID, "pause", 1n, 2n), resumed);
  assert.equal(
    controller.signal.aborted,
    false,
    "stale pause must not cancel newer work",
  );
  assert.throws(() => lifecycle(h.state, 1n, ID, "pause", 1n, 4n), {
    code: "session_conflict",
  });
  assert.equal(controller.signal.aborted, false);
  h.feed(10_000n);
  const stopped = lifecycle(h.state, 1n, ID, "stop", 3n, 4n);
  assert.equal(stopped.settledMs, 75_000n);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(lifecycle(h.state, 1n, ID, "stop", 3n, 4n), stopped);
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    36_000_000n - 75_000n,
  );
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 0n);
  assert.equal(h.state.sessions.size, 0);
});

test("expiry splits exact reservations between the old monthly grant and pack", (t) => {
  const h = fixture(t);
  h.db
    .prepare(
      "UPDATE allowance_grants SET valid_until_ms=? WHERE origin='original'",
    )
    .run(h.state.clock() + 7500n);
  h.db
    .transaction(() =>
      insertGrant(
        h.db,
        1n,
        "pack",
        "pack",
        10_800_000n,
        6n,
        h.state.clock(),
        null,
      ),
    )
    .immediate();
  h.create();
  h.feed(12_000n, ["microphone", "system"]);
  lifecycle(h.state, 1n, ID, "stop", 1n, 1n);
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT origin,meeting_ms_used,meeting_ms_reserved FROM allowance_grants ORDER BY origin",
      )
      .all(),
    [
      { origin: "original", meeting_ms_used: 7500n, meeting_ms_reserved: 0n },
      { origin: "pack", meeting_ms_used: 4500n, meeting_ms_reserved: 0n },
    ],
  );
});

test("fractional PCM carry settles the same duration regardless of frame boundaries or gaps", (t) => {
  for (const [size, gap] of [
    [32000, 0],
    [640, 0],
    [32, 0],
    [2, 0],
    [2, 5],
  ]) {
    const h = fixture(t);
    const row = h.create();
    const generation = attachSource(
      h.state,
      row,
      "microphone",
      h.state.clock(),
    );
    for (let bytes = 0; bytes < 32_000; bytes += size) {
      h.advance(BigInt(gap));
      onAudio(h.state, 1n, ID, "microphone", size, h.state.clock(), {
        version: row.lease_version,
        generation,
      });
    }
    settleDisconnectedSource(h.state, 1n, ID, "microphone", generation);
    assert.equal(h.view().settledMs, 1000n, `size=${size} gap=${gap}`);
    assert.equal(h.view().state, "paused");
    assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 0n);
    settleDisconnectedSource(h.state, 1n, ID, "microphone", generation);
    assert.equal(h.view().settledMs, 1000n);
    assert.throws(() =>
      checkAudio(h.state, row.id, "microphone", generation, 2, h.state.clock()),
    );
  }
});

test("account pacing survives reconnect and stale owners cannot mutate health or metering", (t) => {
  const h = fixture(t),
    row = h.create();
  const first = attachSource(h.state, row, "microphone", h.state.clock());
  checkAudio(h.state, row.id, "microphone", first, 32_000, h.state.clock());
  onAudio(h.state, 1n, ID, "microphone", 32_000, h.state.clock(), {
    version: 1n,
    generation: first,
  });
  const next = attachSource(h.state, row, "microphone", h.state.clock());
  const before = structuredClone(h.state.sessions.get(row.id));
  assert.throws(
    () =>
      onAudio(h.state, 1n, ID, "microphone", 32, h.state.clock(), {
        version: 1n,
        generation: first,
      }),
    { code: "session_conflict" },
  );
  assert.deepEqual(h.state.sessions.get(row.id), before);
  assert.throws(
    () => checkAudio(h.state, row.id, "microphone", next, 2, h.state.clock()),
    { code: "invalid_request" },
  );
  detachSource(h.state, row.id, "microphone", first);
  assert.equal(sourceGeneration(h.state, row.id, "microphone"), next);
  assert.equal(healthyAudio(h.state, row.id, h.state.clock()), false);
  h.advance(1000n);
  checkAudio(h.state, row.id, "microphone", next, 32_000, h.state.clock());
  assert.throws(
    () => checkAudio(h.state, row.id, "microphone", next, 3, h.state.clock()),
    { code: "invalid_request" },
  );
});

test("restart and lease expiry absorb uncheckpointed time and release revoked reservations", (t) => {
  for (const [audioMs, durableMs, idleMs, revoked] of [
    [6500n, 5000n, 30_000n, true],
    [12_000n, 10_000n, 120_000n, false],
  ] as const) {
    for (const restart of [true, false]) {
      const h = fixture(t);
      h.create();
      h.feed(audioMs);
      const checkpoint = h.view().settledMs;
      assert.equal(checkpoint, durableMs);
      if (revoked) h.db.prepare("UPDATE allowance_grants SET revoked=1").run();
      if (restart) recoverRestart(h.state);
      else {
        h.advance(idleMs);
        assert.equal(expireStaleSessions(h.state), 1);
      }
      assert.equal(h.view().settledMs, checkpoint);
      assert.equal(h.view().state, "stopped");
      assert.deepEqual(
        h.db.prepare("SELECT meeting_ms_reserved FROM allowance_grants").get(),
        { meeting_ms_reserved: 0n },
      );
      assert.deepEqual(
        h.db.prepare("SELECT count(*) AS n FROM session_reservations").get(),
        { n: 0n },
      );
      assert.equal(h.state.sessions.size, 0);
      assert.equal(
        balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
        revoked ? 0n : 36_000_000n - durableMs,
      );
    }
  }
});

test("delayed pause after resume cannot prevent restart from releasing revoked grants", (t) => {
  const h = fixture(t);
  h.create();
  h.feed(12_000n);
  const resumed = lifecycle(h.state, 1n, ID, "resume", 1n, 2n);
  const stale = lifecycle(h.state, 1n, ID, "pause", 1n, 1n);
  assert.deepEqual(stale, resumed);
  assert.equal(stale.state, "active");
  assert.equal(stale.settledMs, 12_000n);
  h.db.prepare("UPDATE allowance_grants SET revoked=1").run();
  recoverRestart(h.state);
  assert.deepEqual(
    h.db
      .prepare("SELECT sum(meeting_ms_reserved) AS n FROM allowance_grants")
      .get(),
    { n: 0n },
  );
  assert.deepEqual(
    h.db.prepare("SELECT count(*) AS n FROM session_reservations").get(),
    { n: 0n },
  );
  assert.equal(h.view().state, "stopped");
  assert.equal(h.view().settledMs, 12_000n);
});

test("exhaustion requires explicit resume, session ownership and single-account admission", (t) => {
  const h = fixture(t, 1000n);
  const row = h.create();
  assert.throws(() => h.create(OTHER), { code: "session_conflict" });
  assert.throws(() => requireSession(h.db, 2n, ID), {
    code: "session_conflict",
  });
  assert.deepEqual(h.create(), row);
  const generation = attachSource(h.state, row, "microphone", h.state.clock());
  onAudio(h.state, 1n, ID, "microphone", 32_000, h.state.clock(), {
    version: 1n,
    generation,
  });
  h.advance(1000n);
  assert.equal(
    onAudio(h.state, 1n, ID, "microphone", 32, h.state.clock(), {
      version: 1n,
      generation,
    }),
    "exhausted",
  );
  assert.equal(h.view().settledMs, 1000n);
  assert.equal(h.view().state, "paused");
  assert.throws(() => lifecycle(h.state, 1n, ID, "resume", 2n, 1n), {
    code: "quota_exhausted",
  });
  h.db
    .transaction(() =>
      insertGrant(
        h.db,
        1n,
        "topup",
        "pack",
        10_800_000n,
        0n,
        h.state.clock(),
        null,
      ),
    )
    .immediate();
  assert.equal(h.view().state, "paused");
  assert.equal(lifecycle(h.state, 1n, ID, "resume", 2n, 1n).state, "active");
  assert.throws(() => lifecycle(h.state, 1n, ID, "pause", 2n, 2n), {
    code: "session_conflict",
  });
  h.feed(6000n);
  assert.equal(lifecycle(h.state, 1n, ID, "stop", 3n, 2n).settledMs, 7000n);
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    10_800_000n - 6000n,
  );
});

test("idle closes delivered coverage only and a new explicit meeting supersedes an unreserved pause", (t) => {
  const h = fixture(t),
    row = h.create();
  const generation = attachSource(h.state, row, "microphone", h.state.clock());
  onAudio(h.state, 1n, ID, "microphone", 3200, h.state.clock(), {
    version: 1n,
    generation,
  });
  h.advance(5000n);
  assert.equal(onIdleCheck(h.state, 1n, ID, h.state.clock()), true);
  assert.equal(h.view().settledMs, 100n);
  settleDisconnectedSource(h.state, 1n, ID, "microphone", generation);
  assert.equal(h.view().state, "paused");
  const replacement = h.create(OTHER);
  assert.equal(replacement.state, "active");
  assert.equal(h.view().state, "stopped");
});

test("provider pause preserves observed coverage and frame admission limits survive a source reconnect", (t) => {
  const h = fixture(t),
    row = h.create();
  const generation = attachSource(h.state, row, "microphone", h.state.clock());
  for (let count = 0; count < 200; count++)
    checkAudio(h.state, row.id, "microphone", generation, 2, h.state.clock());
  assert.throws(
    () =>
      checkAudio(h.state, row.id, "microphone", generation, 2, h.state.clock()),
    { code: "rate_limited" },
  );
  const next = attachSource(h.state, row, "microphone", h.state.clock());
  assert.throws(
    () => checkAudio(h.state, row.id, "microphone", next, 2, h.state.clock()),
    { code: "rate_limited" },
  );
  h.advance(1000n);
  checkAudio(h.state, row.id, "microphone", next, 3200, h.state.clock());
  onAudio(h.state, 1n, ID, "microphone", 3200, h.state.clock(), {
    version: 1n,
    generation: next,
  });
  h.advance(500n);
  const paused = pauseSession(h.state, 1n, ID);
  assert.equal(paused.settledMs, 100n);
  assert.equal(paused.state, "paused");
  assert.equal(h.state.sessions.size, 0);
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 0n);
});

test("session IDs canonicalize Rust UUID formats and reject malformed values", () => {
  for (const value of [
    ID,
    ` {${ID}} `,
    `urn:uuid:${ID}`,
    ID.replaceAll("-", ""),
  ])
    assert.equal(validateSessionId(value), ID);
  for (const value of [
    "",
    "not-a-uuid",
    `${ID}a`,
    "0000000-00000-0000-0000-000000000001",
  ])
    assert.throws(() => validateSessionId(value), { code: "invalid_request" });
});

test("six ten-minute meetings charge one hour and reconnecting dual sources never doubles time", (t) => {
  const h = fixture(t);
  for (let i = 0; i < 6; i++) {
    const id = `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`;
    h.create(id);
    h.feed(600_000n, ["microphone"], id);
    assert.equal(
      lifecycle(h.state, 1n, id, "stop", 1n, 1n).settledMs,
      600_000n,
    );
    h.advance(120_000n);
  }
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    32_400_000n,
  );
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 0n);
  const id = "00000000-0000-0000-0000-000000000007";
  h.create(id);
  h.feed(10_000n, ["microphone"], id);
  const row = requireSession(h.db, 1n, id);
  const old = attachSource(h.state, row, "microphone", h.state.clock());
  const current = attachSource(h.state, row, "microphone", h.state.clock());
  assert.ok(current > old);
  h.feed(10_000n, ["microphone", "system"], id);
  assert.equal(lifecycle(h.state, 1n, id, "stop", 1n, 1n).settledMs, 20_000n);
});

test("duplicate frames and bulk upload are refused while exact checkpoint exhaustion stops immediately", (t) => {
  const h = fixture(t);
  h.create();
  assert.throws(
    () =>
      onAudio(h.state, 1n, ID, "microphone", 3_600 * 32_000, h.state.clock()),
    { code: "invalid_request" },
  );
  assert.equal(h.view().settledMs, 0n);
  let accepted = 0,
    refused = false;
  for (let i = 0; i < 60 && !refused; i++) {
    for (let j = 0; j < 2; j++) {
      try {
        onAudio(h.state, 1n, ID, "microphone", 16_000, h.state.clock());
        accepted++;
      } catch (error) {
        assert.equal((error as { code: string }).code, "invalid_request");
        refused = true;
      }
    }
    h.advance(500n);
  }
  assert.ok(accepted > 0 && refused);
  for (const allowance of [500n, 5000n, 8000n]) {
    const exact = fixture(t, allowance);
    exact.create();
    exact.feed(allowance);
    assert.equal(
      onAudio(exact.state, 1n, ID, "microphone", 16_000, exact.state.clock()),
      "exhausted",
    );
    assert.equal(exact.view().settledMs, allowance);
    assert.equal(exact.view().state, "paused");
    assert.equal(
      balance(exact.db, 1n, exact.state.clock()).meetingMsAvailable,
      0n,
    );
    assert.equal(
      balance(exact.db, 1n, exact.state.clock()).meetingMsReserved,
      0n,
    );
  }
});

test("warnings precede exhaustion, foreign lifecycle commands leave balances intact and abandoned sessions cannot resume", (t) => {
  const h = fixture(t, 90_000n);
  h.create();
  assert.equal(h.view().warning, "two_minutes_left");
  h.db
    .transaction(() =>
      insertGrant(
        h.db,
        2n,
        "other",
        "monthly",
        36_000_000n,
        20n,
        h.state.clock(),
        null,
      ),
    )
    .immediate();
  for (const action of ["pause", "resume", "stop"] as const)
    assert.throws(() => lifecycle(h.state, 2n, ID, action, 1n, 1n), {
      code: "session_conflict",
    });
  assert.equal(
    balance(h.db, 2n, h.state.clock()).meetingMsAvailable,
    36_000_000n,
  );
  lifecycle(h.state, 1n, ID, "pause", 1n, 1n);
  h.create(OTHER);
  assert.throws(() => lifecycle(h.state, 1n, ID, "resume", 3n, 2n), {
    code: "session_conflict",
  });
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 30_000n);
});

test("idle gaps bill delivered coverage and a stale fresh source cannot make transcription healthy", (t) => {
  const h = fixture(t);
  h.create();
  h.feed(1000n);
  onAudio(h.state, 1n, ID, "microphone", 16_000, h.state.clock());
  h.advance(4000n);
  h.feed(1000n);
  onAudio(h.state, 1n, ID, "microphone", 16_000, h.state.clock());
  assert.equal(lifecycle(h.state, 1n, ID, "stop", 1n, 1n).settledMs, 2500n);
  const stopped = requireSession(h.db, 1n, ID);
  const system = attachSource(h.state, stopped, "system", h.state.clock());
  detachSource(h.state, stopped.id, "system", system);
  assert.ok(attachSource(h.state, stopped, "system", h.state.clock()) > system);
  const row = h.create(OTHER);
  const first = attachSource(h.state, row, "microphone", h.state.clock());
  const current = attachSource(h.state, row, "microphone", h.state.clock());
  assert.throws(
    () =>
      onAudio(h.state, 1n, OTHER, "microphone", 3200, h.state.clock(), {
        version: 1n,
        generation: first,
      }),
    { code: "session_conflict" },
  );
  assert.equal(healthyAudio(h.state, row.id, h.state.clock()), false);
  assert.equal(requireSession(h.db, 1n, OTHER).settled_ms, 0n);
  onAudio(h.state, 1n, OTHER, "microphone", 3200, h.state.clock(), {
    version: 1n,
    generation: current,
  });
  assert.equal(healthyAudio(h.state, row.id, h.state.clock()), false);
  h.advance(100n);
  h.feed(4000n, ["microphone"], OTHER);
  assert.equal(healthyAudio(h.state, row.id, h.state.clock()), true);
  detachSource(h.state, row.id, "microphone", current);
  assert.equal(healthyAudio(h.state, row.id, h.state.clock()), false);
  assert.ok(
    attachSource(h.state, row, "microphone", h.state.clock()) > current,
  );
});

test("short PCM scheduling gaps renew reservations for one or two sources without false exhaustion", (t) => {
  for (const sources of [
    ["microphone"],
    ["microphone", "system"],
  ] as Source[][]) {
    const h = fixture(t);
    h.create();
    for (let frame = 0; frame < 1200; frame++) {
      for (const source of sources)
        assert.equal(
          onAudio(
            h.state,
            1n,
            ID,
            source,
            frame === 0 ? 1568 : 1600,
            h.state.clock(),
          ),
          "continue",
        );
      h.advance(frame < 600 ? 55n : 50n);
    }
    const stopped = lifecycle(h.state, 1n, ID, "stop", 1n, 1n);
    assert.equal(stopped.settledMs, 59_999n);
    assert.equal(
      balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
      35_940_001n,
    );
    assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 0n);
  }
});

test("a restored SQLite snapshot preserves identities and unique grants while absorbing uncheckpointed time", async (t) => {
  const h = fixture(t);
  h.create();
  h.feed(12_000n);
  assert.equal(h.view().settledMs, 10_000n);
  const directory = await mkdtemp(join(tmpdir(), "savvy-session-restore-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "restored.sqlite");
  await h.db.backup(path);
  const restoredDb = openServiceDatabase(path);
  try {
    const restored = new ServiceState(
      h.state.config,
      restoredDb,
      h.state.clock,
      h.state.authorize,
    );
    recoverRestart(restored);
    const row = requireSession(restoredDb, 1n, ID);
    assert.equal(row.state, "stopped");
    assert.equal(row.settled_ms, 10_000n);
    assert.equal(row.reserved_ms, 0n);
    assert.equal(
      balance(restoredDb, 1n, h.state.clock()).meetingMsAvailable,
      36_000_000n - 10_000n,
    );
    assert.equal(
      restoredDb
        .transaction(() =>
          insertGrant(
            restoredDb,
            1n,
            "original",
            "monthly",
            36_000_000n,
            20n,
            h.state.clock(),
            null,
          ),
        )
        .immediate(),
      false,
    );
    assert.deepEqual(
      restoredDb
        .prepare("SELECT id,issuer,subject FROM accounts ORDER BY id")
        .all(),
      h.db.prepare("SELECT id,issuer,subject FROM accounts ORDER BY id").all(),
    );
    assert.deepEqual(
      restoredDb
        .prepare(
          "SELECT kind,amount_ms,operation_key FROM usage_events ORDER BY id",
        )
        .all(),
      h.db
        .prepare(
          "SELECT kind,amount_ms,operation_key FROM usage_events ORDER BY id",
        )
        .all(),
    );
    assert.equal(restoredDb.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(restoredDb.pragma("foreign_key_check"), []);
    assert.ok(
      h.view().state === "active" &&
        requireSession(h.db, 1n, ID).reserved_ms > 0n,
      "restoring a copy must not mutate the source",
    );
  } finally {
    restoredDb.close();
  }
});
