import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { openServiceDatabase } from "./db.js";
import {
  grantFixture,
  insertGrant,
  reserveBrief,
  settleBriefSuccess,
  releaseBrief,
  balance,
  requestState,
  reserveAttempt,
  accountSummary,
} from "./billing.js";
import { json } from "./errors.js";

test("ledger grants once, spends expiring allowance first, releases failure, and rejects revoked settlement", () => {
  const db = openServiceDatabase(":memory:");
  const now = 1_700_000_000_000n;
  const run = <T>(fn: () => T) => db.transaction(fn).immediate();
  try {
    db.prepare(
      "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','subject',?)",
    ).run(now);
    run(() => {
      assert.equal(
        insertGrant(
          db,
          1n,
          "monthly",
          "monthly",
          3_600_000n,
          1n,
          now,
          now + 1000n,
        ),
        true,
      );
      assert.equal(
        insertGrant(
          db,
          1n,
          "monthly",
          "monthly",
          3_600_000n,
          1n,
          now,
          now + 1000n,
        ),
        false,
      );
      insertGrant(db, 1n, "pack", "pack", 10_800_000n, 2n, now, null);
      reserveBrief(db, 1n, "first", now);
    });
    assert.equal(balance(db, 1n, now).briefsReserved, 1n);
    assert.equal(
      (
        db
          .prepare(
            "SELECT kind FROM allowance_grants JOIN provider_requests ON grant_id=allowance_grants.id WHERE request_key='first'",
          )
          .get() as { kind: string }
      ).kind,
      "monthly",
    );
    run(() => settleBriefSuccess(db, 1n, "first", now));
    assert.equal(balance(db, 1n, now).briefsAvailable, 2n);
    assert.throws(() => run(() => settleBriefSuccess(db, 1n, "first", now)), {
      code: "result_unavailable",
    });
    run(() => reserveBrief(db, 1n, "failed", now));
    run(() => releaseBrief(db, 1n, "failed", now));
    run(() => releaseBrief(db, 1n, "failed", now));
    assert.equal(balance(db, 1n, now).briefsReserved, 0n);
    assert.equal(balance(db, 1n, now).briefsAvailable, 2n);
    assert.equal(requestState(db, 1n, "failed"), "failed");
    run(() => reserveBrief(db, 1n, "revoked", now));
    db.prepare(
      "UPDATE allowance_grants SET revoked=1 WHERE origin='pack'",
    ).run();
    assert.throws(() => run(() => settleBriefSuccess(db, 1n, "revoked", now)), {
      code: "quota_exhausted",
    });
    run(() => releaseBrief(db, 1n, "revoked", now));
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM usage_events WHERE kind='debit_brief'",
          )
          .get() as { count: bigint }
      ).count,
      1n,
    );
    assert.equal(balance(db, 1n, now + 1000n).meetingMsAvailable, 0n);
    const summary = JSON.parse(json(accountSummary(db, 1n, now)));
    assert.equal(summary.accountIdentity, "subject");
    assert.equal(summary.allowances.pack.briefsAvailable, 0);
    assert.equal(summary.subscription, null);
  } finally {
    db.close();
  }
});

test("attempt admission and last-brief reservation roll back atomically", () => {
  const db = openServiceDatabase(":memory:");
  const now = 1000n;
  const run = <T>(fn: () => T) => db.transaction(fn).immediate();
  try {
    db.prepare(
      "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','subject',?)",
    ).run(now);
    run(() => insertGrant(db, 1n, "only", "pack", 1000n, 1n, now, null));
    for (let i = 0; i < 6; i++)
      run(() => reserveAttempt(db, 1n, "brief", now, 60_000n, 6n));
    assert.throws(
      () =>
        run(() => {
          reserveBrief(db, 1n, "throttled", now);
          reserveAttempt(db, 1n, "brief", now, 60_000n, 6n);
        }),
      { code: "rate_limited" },
    );
    assert.equal(requestState(db, 1n, "throttled"), undefined);
    assert.equal(balance(db, 1n, now).briefsReserved, 0n);
    run(() => reserveBrief(db, 1n, "winner", now));
    assert.throws(() => run(() => reserveBrief(db, 1n, "loser", now)), {
      code: "quota_exhausted",
    });
    assert.equal(requestState(db, 1n, "loser"), undefined);
    assert.equal(balance(db, 1n, now).briefsReserved, 1n);
  } finally {
    db.close();
  }
});

test("service schema matches the recorded schema snapshot", () => {
  const snapshot = JSON.parse(
    readFileSync(
      new URL("../e2e/service-schema.json", import.meta.url),
      "utf8",
    ),
  );
  const db = openServiceDatabase(":memory:");
  try {
    // SQLite metadata is small; ordinary integers make the snapshot JSON comparable.
    db.defaultSafeIntegers(false);
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const schema = tables.map(({ name }) => ({
      name,
      columns: db.pragma(`table_info('${name}')`),
      foreignKeys: db.pragma(`foreign_key_list('${name}')`),
      indexes: (
        db.pragma(`index_list('${name}')`) as {
          name: string;
          unique: number;
          origin: string;
          partial: number;
        }[]
      ).map(({ name: index, unique, origin, partial }) => ({
        name: index,
        unique,
        origin,
        partial,
        columns: db.pragma(`index_info('${index}')`),
      })),
    }));
    assert.deepEqual(schema, snapshot);
  } finally {
    db.close();
  }
});

test("managed fixture allowances, verified identity and durable attempt limits survive a SQLite backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "savvy-ledger-backup-"));
  const db = openServiceDatabase(":memory:");
  const now = 1_700_000_000_000n;
  try {
    db.prepare(
      "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','restore-user',?)",
    ).run(now);
    db.transaction(() => grantFixture(db, 1n, "monthly", now)).immediate();
    let summary = accountSummary(db, 1n, now);
    assert.equal(summary.meetingMsAvailable, 36_000_000n);
    assert.equal(summary.briefsAvailable, 20n);
    assert.equal(summary.policyVersion, "managed_v1");
    db.transaction(() => grantFixture(db, 1n, "pack", now)).immediate();
    summary = accountSummary(db, 1n, now);
    assert.equal(summary.meetingMsAvailable, 46_800_000n);
    assert.equal(summary.briefsAvailable, 26n);
    db.transaction(() => {
      for (let i = 0; i < 6; i++)
        reserveAttempt(db, 1n, "brief", now, 60_000n, 6n);
    }).immediate();
    const path = join(directory, "restored.sqlite");
    await db.backup(path);
    const restored = openServiceDatabase(path);
    try {
      const identity = restored
        .prepare(
          "SELECT id FROM accounts WHERE issuer='issuer' AND subject='restore-user'",
        )
        .get();
      assert.deepEqual(identity, { id: 1n });
      assert.deepEqual(accountSummary(restored, 1n, now), summary);
      assert.throws(
        () =>
          restored
            .transaction(() =>
              reserveAttempt(restored, 1n, "brief", now, 60_000n, 6n),
            )
            .immediate(),
        { code: "rate_limited" },
      );
      assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
