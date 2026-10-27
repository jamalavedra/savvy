import assert from "node:assert/strict";
import { test } from "node:test";
import { openServiceDatabase, migrateService } from "./db.js";
import {
  accountSummary,
  balance,
  insertGrant,
  reserveBrief,
  settleBriefSuccess,
} from "./billing.js";
import { createSession, finishInterval } from "./sessions.js";
import {
  fundingChoice,
  fundingForRow,
  assertFundingChoice,
  type FundingContext,
} from "./funding.js";
import {
  assertFundingCapability,
  activateTeamPurchases,
  disableTeamPurchases,
  requiredFundingSchema,
  teamPurchasesEnabled,
} from "./capability.js";

const now = 1_700_000_000_000n;
function fixture() {
  const db = openServiceDatabase(":memory:");
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','actor',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(2,'issuer','other',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO organizations(id,name,created_at_ms) VALUES(1,'Team',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO organization_members VALUES(1,1,'owner','owner@example.test',?)",
  ).run(now);
  db.prepare("INSERT INTO seats VALUES(1,1,1,'active',?)").run(now);
  db.prepare(
    "INSERT INTO seat_assignments(id,seat_id,account_id,assigned_at_ms) VALUES(1,1,1,?)",
  ).run(now);
  db.prepare(
    "INSERT INTO seat_periods VALUES(1,1,1,'in_team',?,?, 'price_monthly',1000000,20,'paid')",
  ).run(now, now + 1_000_000n);
  db.transaction(() => {
    insertGrant(db, 1n, "personal", "monthly", 100_000n, 2n, now, null);
    insertGrant(db, 1n, "seat", "seat", 1_000_000n, 20n, now, now + 1_000_000n);
    db.prepare(
      "UPDATE allowance_grants SET seat_assignment_id=1,seat_period_id=1 WHERE origin='seat'",
    ).run();
  }).immediate();
  return db;
}
const organization: FundingContext = {
  kind: "organization",
  organizationId: 1n,
  assignmentId: 1n,
};

test("personal wire totals and meeting reservations exclude seat grants even on legacy requests", () => {
  const db = fixture();
  try {
    assert.equal(accountSummary(db, 1n, now).meetingMsAvailable, 100_000n);
    assert.equal(balance(db, 1n, now).briefsAvailable, 2n);
    db.transaction(() =>
      createSession(db, 1n, "legacy-meeting", now),
    ).immediate();
    assert.equal(
      db
        .prepare<[], { meeting_ms_reserved: bigint }>(
          "SELECT meeting_ms_reserved FROM allowance_grants WHERE origin='seat'",
        )
        .get()!.meeting_ms_reserved,
      0n,
    );
    db.transaction(() => reserveBrief(db, 1n, "legacy-brief", now)).immediate();
    assert.equal(
      db
        .prepare<[], { briefs_reserved: bigint }>(
          "SELECT briefs_reserved FROM allowance_grants WHERE origin='seat'",
        )
        .get()!.briefs_reserved,
      0n,
    );
    db.transaction(() =>
      finishInterval(db, 1n, "legacy-meeting", "test", now),
    ).immediate();
    db.prepare(
      "UPDATE allowance_grants SET revoked=1 WHERE origin='personal'",
    ).run();
    assert.throws(
      () =>
        db
          .transaction(() => reserveBrief(db, 1n, "no-fallback", now))
          .immediate(),
      { code: "quota_exhausted" },
    );
    assert.equal(balance(db, 1n, now).meetingMsAvailable, 0n);
  } finally {
    db.close();
  }
});

test("organization scope cannot select personal funds or another actor's assignment", () => {
  const db = fixture();
  try {
    assert.equal(
      balance(db, 1n, now, organization).meetingMsAvailable,
      1_000_000n,
    );
    db.transaction(() =>
      reserveBrief(db, 1n, "seat-brief", now, organization),
    ).immediate();
    assert.equal(
      db
        .prepare<[], { briefs_reserved: bigint }>(
          "SELECT briefs_reserved FROM allowance_grants WHERE origin='personal'",
        )
        .get()!.briefs_reserved,
      0n,
    );
    assert.throws(() => balance(db, 2n, now, organization), {
      code: "no_seat",
    });
    db.prepare(
      "UPDATE allowance_grants SET briefs_total=1 WHERE origin='seat'",
    ).run();
    assert.throws(
      () =>
        db
          .transaction(() =>
            reserveBrief(db, 1n, "exhausted-seat", now, organization),
          )
          .immediate(),
      { code: "quota_exhausted" },
    );
    assert.equal(balance(db, 1n, now).briefsAvailable, 2n);
    db.prepare("UPDATE seat_assignments SET ended_at_ms=? WHERE id=1").run(
      now + 1n,
    );
    assert.throws(
      () =>
        db
          .transaction(() => settleBriefSuccess(db, 1n, "seat-brief", now + 1n))
          .immediate(),
      { code: "no_seat" },
    );
  } finally {
    db.close();
  }
});

test("frozen retries reject payer changes and organization requests require a free person session", () => {
  const db = fixture();
  try {
    const row = db
      .transaction(() => createSession(db, 1n, "frozen", now))
      .immediate();
    assert.equal(row.funding_scope, "personal");
    assert.throws(
      () =>
        db
          .transaction(() =>
            createSession(db, 1n, "frozen", now, {
              kind: "organization",
              organizationId: "1",
            }),
          )
          .immediate(),
      { code: "funding_mismatch" },
    );
    assert.throws(
      () =>
        db
          .transaction(() =>
            createSession(db, 1n, "new", now, {
              kind: "organization",
              organizationId: "1",
            }),
          )
          .immediate(),
      { code: "session_conflict" },
    );
    assert.throws(
      () =>
        assertFundingChoice(
          fundingForRow(db, 1n, {
            funding_scope: "organization",
            funding_assignment_id: 1n,
          }),
        ),
      { code: "funding_mismatch" },
    );
  } finally {
    db.close();
  }
});

test("funding payload rejects forged assignment IDs, malformed IDs and unknown properties", () => {
  for (const body of [
    null,
    { kind: "other" },
    { kind: "personal", organizationId: "1" },
    { kind: "organization", organizationId: 1 },
    { kind: "organization", organizationId: "01" },
    { kind: "organization", organizationId: "9223372036854775808" },
    { kind: "organization", organizationId: "1", assignmentId: "2" },
  ])
    assert.equal(fundingChoice.safeParse(body).success, false);
  assert.equal(
    fundingChoice.safeParse({
      kind: "organization",
      organizationId: "9223372036854775807",
    }).success,
    true,
  );
});

test("migration is additive and idempotent and backfills personal Stripe customers", () => {
  const db = fixture();
  try {
    db.prepare(
      "UPDATE accounts SET stripe_customer_id='cus_personal' WHERE id=1",
    ).run();
    migrateService(db);
    migrateService(db);
    assert.deepEqual(
      db
        .prepare(
          "SELECT owner_kind,owner_id FROM stripe_customers WHERE stripe_customer_id='cus_personal'",
        )
        .get(),
      { owner_kind: "account", owner_id: 1n },
    );
    assert.equal(
      db
        .prepare<[], { n: bigint }>(
          "SELECT count(*) AS n FROM allowance_grants",
        )
        .get()!.n,
      2n,
    );
  } finally {
    db.close();
  }
});

test("capability guard fails closed and disabling acquisition preserves the immutable rollback floor", () => {
  const db = fixture();
  try {
    assert.equal(requiredFundingSchema(db), 0);
    assert.equal(teamPurchasesEnabled(db), false);
    assert.throws(() => activateTeamPurchases(db, "a".repeat(40), 2, now));
    assert.equal(requiredFundingSchema(db), 0);
    activateTeamPurchases(db, "a".repeat(40), 2, now, 2);
    assert.equal(teamPurchasesEnabled(db), true);
    assert.throws(() => assertFundingCapability(db, 1));
    assert.throws(() => assertFundingCapability(db, 0));
    assertFundingCapability(db, 2);
    disableTeamPurchases(db, now);
    assert.equal(teamPurchasesEnabled(db), false);
    assert.equal(requiredFundingSchema(db), 2);
    assert.throws(() => activateTeamPurchases(db, "b".repeat(40), 2, now, 2));
    db.prepare(
      "UPDATE service_capabilities SET value='invalid' WHERE key='required_funding_schema'",
    ).run();
    assert.throws(() => assertFundingCapability(db, 2));
  } finally {
    db.close();
  }
});

test("migration refuses a customer registry conflict without reassigning the organization customer", () => {
  const db = fixture();
  try {
    db.prepare(
      "INSERT INTO stripe_customers VALUES('cus_collision','organization',1)",
    ).run();
    db.prepare(
      "UPDATE accounts SET stripe_customer_id='cus_collision' WHERE id=1",
    ).run();
    assert.throws(() => migrateService(db), /ownership conflicts/);
    assert.deepEqual(
      db
        .prepare(
          "SELECT owner_kind,owner_id FROM stripe_customers WHERE stripe_customer_id='cus_collision'",
        )
        .get(),
      { owner_kind: "organization", owner_id: 1n },
    );
  } finally {
    db.close();
  }
});
