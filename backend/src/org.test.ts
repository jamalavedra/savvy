import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { openServiceDatabase } from "./db.js";
import { configuration } from "./config.js";
import { ServiceState } from "./state.js";
import { setCapability, disableTeamPurchases } from "./capability.js";
import {
  createOrganization,
  inviteMember,
  acceptInvitation,
  resendInvitation,
  revokeInvitation,
  assignSeat,
  unassignSeat,
  transferOwner,
  removeMember,
  organizationView,
  grantForAssignment,
  assertSeatConservation,
  type SeatPeriod,
  type Assignment,
} from "./org.js";
import {
  balance,
  insertGrant,
  reserveBrief,
  settleBriefSuccess,
} from "./billing.js";
import {
  createSession,
  requireSession,
  onAudio,
  finishInterval,
} from "./sessions.js";
import { completeRequest } from "./advice.js";
import type { FundingChoice } from "./funding.js";

function fixture(t: TestContext) {
  const db = openServiceDatabase(":memory:");
  t.after(() => db.close());
  let now = 1_700_000_000_000n;
  const tx = <T>(fn: () => T) => db.transaction(fn).immediate();
  for (let i = 1; i <= 5; i++)
    db.prepare(
      "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(?,'issuer',?,?)",
    ).run(i, `person-${i}`, now);
  tx(() => setCapability(db, "team_purchase_enabled", "1", now));
  const org = tx(() =>
    createOrganization(db, 1n, "Our team", now, "owner@example.test"),
  );
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
  const join = (account: bigint, auto = false) => {
    const email = `person-${account}@example.test`;
    const invite = tx(() => inviteMember(db, 1n, org, email, auto, now));
    return tx(() => acceptInvitation(db, account, email, invite.token, now));
  };
  const paid = (
    budgetMs = 100_000n,
    briefs = 3n,
    starts = now,
    ends = now + 100_000n,
  ) =>
    tx(() => {
      const seat = BigInt(
        db
          .prepare(
            "INSERT INTO seats(organization_id,seat_number,status,created_at_ms) VALUES(?,COALESCE((SELECT max(seat_number)+1 FROM seats WHERE organization_id=?),1),'active',?)",
          )
          .run(org, org, now).lastInsertRowid,
      );
      db.prepare(
        "INSERT INTO seat_periods(organization_id,seat_id,invoice_id,starts_ms,ends_ms,price_id,budget_ms,budget_briefs,financial_status) VALUES(?,?,'in_current',?,?,'price_monthly',?,?,'paid')",
      ).run(org, seat, starts, ends, budgetMs, briefs);
      return seat;
    });
  const funding: FundingChoice = {
    kind: "organization",
    organizationId: org.toString(),
  };
  return {
    db,
    state,
    tx,
    org,
    join,
    paid,
    funding,
    now: () => now,
    advance: (ms: bigint) => {
      now += ms;
    },
  };
}

test("invitation verification, rotation, revocation and capacity-full acceptance are atomic", (t) => {
  const h = fixture(t);
  const { db, tx, org } = h;
  const original = tx(() =>
    inviteMember(db, 1n, org, "  Person-2@Example.Test ", true, h.now()),
  );
  assert.throws(
    () =>
      tx(() =>
        acceptInvitation(db, 2n, "wrong@example.test", original.token, h.now()),
      ),
    { code: "invalid_request" },
  );
  const rotated = tx(() =>
    resendInvitation(db, 1n, org, BigInt(original.id), h.now()),
  );
  assert.throws(
    () =>
      tx(() =>
        acceptInvitation(
          db,
          2n,
          "person-2@example.test",
          original.token,
          h.now(),
        ),
      ),
    { code: "invalid_request" },
  );
  disableTeamPurchases(db, h.now());
  const accepted = tx(() =>
    acceptInvitation(db, 2n, "person-2@example.test", rotated.token, h.now()),
  );
  assert.deepEqual(accepted, {
    joined: true,
    organizationId: org.toString(),
    seat: false,
    reason: "no_free_seat",
  });
  assert.throws(
    () =>
      tx(() =>
        acceptInvitation(
          db,
          2n,
          "person-2@example.test",
          rotated.token,
          h.now(),
        ),
      ),
    { code: "invalid_request" },
  );
  assert.throws(
    () =>
      tx(() => inviteMember(db, 1n, org, "third@example.test", false, h.now())),
    { code: "team_purchase_disabled" },
  );
  tx(() => setCapability(db, "team_purchase_enabled", "1", h.now()));
  const revoked = tx(() =>
    inviteMember(db, 1n, org, "person-3@example.test", false, h.now()),
  );
  tx(() => revokeInvitation(db, 1n, org, BigInt(revoked.id)));
  assert.throws(
    () =>
      tx(() =>
        acceptInvitation(
          db,
          3n,
          "person-3@example.test",
          revoked.token,
          h.now(),
        ),
      ),
    { code: "invalid_request" },
  );
  const expired = tx(() =>
    inviteMember(db, 1n, org, "person-3@example.test", false, h.now()),
  );
  h.advance(8n * 24n * 3_600_000n);
  assert.throws(
    () =>
      tx(() =>
        acceptInvitation(
          db,
          3n,
          "person-3@example.test",
          expired.token,
          h.now(),
        ),
      ),
    { code: "invalid_request" },
  );
});

test("last-seat admission cannot double assign and foreign organization ownership cannot mutate it", (t) => {
  const h = fixture(t);
  h.join(2n);
  h.join(3n);
  const seat = h.paid();
  const assigned = h.tx(() => assignSeat(h.db, 1n, h.org, 2n, h.now(), seat));
  assert.throws(
    () => h.tx(() => assignSeat(h.db, 1n, h.org, 3n, h.now(), seat)),
    { code: "quota_exhausted" },
  );
  assert.throws(() => h.tx(() => assignSeat(h.db, 2n, h.org, 3n, h.now())), {
    status: 403,
  });
  assert.throws(() => h.tx(() => assignSeat(h.db, 1n, h.org, 4n, h.now())), {
    status: 403,
  });
  assert.equal(
    organizationView(h.db, 2n, h.now()).organization!.assignment!.id,
    assigned.assignmentId,
  );
  const memberJson = JSON.stringify(
    organizationView(h.db, 2n, h.now()),
    (_, v) => (typeof v === "bigint" ? Number(v) : v),
  );
  assert.equal(memberJson.includes("owner@example.test"), false);
  assert.equal(memberJson.includes("person-3@example.test"), false);
  assert.equal(organizationView(h.db, 4n, h.now()).organization, null);
});

test("A to B to A transfers remainder without resetting time or briefs or redispatching late callbacks", (t) => {
  const h = fixture(t);
  h.join(2n);
  h.join(3n);
  const seat = h.paid();
  h.tx(() => assignSeat(h.db, 1n, h.org, 2n, h.now(), seat));
  h.tx(() => createSession(h.db, 2n, "org-call", h.now(), h.funding));
  for (let i = 0; i < 10; i++) {
    onAudio(h.state, 2n, "org-call", "microphone", 16000, h.now());
    h.advance(500n);
  }
  const first = requireSession(h.db, 2n, "org-call").funding_assignment_id!;
  h.tx(() =>
    reserveBrief(h.db, 2n, "finished", h.now(), {
      kind: "organization",
      organizationId: h.org,
      assignmentId: first,
    }),
  );
  h.tx(() => settleBriefSuccess(h.db, 2n, "finished", h.now()));
  h.tx(() =>
    reserveBrief(h.db, 2n, "pending", h.now(), {
      kind: "organization",
      organizationId: h.org,
      assignmentId: first,
    }),
  );
  const cleanup = h.tx(() => unassignSeat(h.state, 1n, h.org, seat, h.now()));
  cleanup();
  cleanup();
  assert.equal(requireSession(h.db, 2n, "org-call").settled_ms, 5_000n);
  assert.equal(requireSession(h.db, 2n, "org-call").state, "stopped");
  assert.throws(
    () => h.tx(() => settleBriefSuccess(h.db, 2n, "pending", h.now())),
    { code: "no_seat" },
  );
  const b = h.tx(() => assignSeat(h.db, 1n, h.org, 3n, h.now(), seat));
  assert.equal(
    balance(h.db, 3n, h.now(), {
      kind: "organization",
      organizationId: h.org,
      assignmentId: BigInt(b.assignmentId),
    }).meetingMsAvailable,
    95_000n,
  );
  h.tx(() => unassignSeat(h.state, 1n, h.org, seat, h.now()))();
  const a = h.tx(() => assignSeat(h.db, 1n, h.org, 2n, h.now(), seat));
  const after = balance(h.db, 2n, h.now(), {
    kind: "organization",
    organizationId: h.org,
    assignmentId: BigInt(a.assignmentId),
  });
  assert.equal(after.meetingMsAvailable, 95_000n);
  assert.equal(after.briefsAvailable, 2n);
  assert.notEqual(first, BigInt(a.assignmentId));
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(DISTINCT origin) AS n FROM allowance_grants WHERE kind='seat'",
      )
      .get()!.n,
    3n,
  );
  assert.throws(
    () => h.tx(() => createSession(h.db, 2n, "org-call", h.now(), h.funding)),
    { code: "session_ended" },
  );
  assert.throws(
    () =>
      h.tx(() => completeRequest(h.state, 2n, "org-call", 1n, "late", h.now())),
    { code: "no_seat" },
  );
});

test("seat revocation leaves the same person's personal call and personal brief controller alone", (t) => {
  const h = fixture(t);
  h.join(2n);
  const seat = h.paid();
  h.tx(() =>
    insertGrant(h.db, 2n, "personal", "pack", 100_000n, 3n, h.now(), null),
  );
  const assigned = h.tx(() => assignSeat(h.db, 1n, h.org, 2n, h.now(), seat));
  h.tx(() => createSession(h.db, 2n, "personal-call", h.now()));
  const controller = new AbortController(),
    personal = new AbortController();
  h.state.cancellations.set(
    2n,
    new Map([
      [
        "org-brief",
        {
          controller,
          fundingAssignmentId: BigInt(assigned.assignmentId),
          sessionId: null,
        },
      ],
      [
        "personal-brief",
        { controller: personal, fundingAssignmentId: null, sessionId: null },
      ],
    ]),
  );
  h.tx(() =>
    reserveBrief(h.db, 2n, "org-brief", h.now(), {
      kind: "organization",
      organizationId: h.org,
      assignmentId: BigInt(assigned.assignmentId),
    }),
  );
  h.tx(() => unassignSeat(h.state, 1n, h.org, seat, h.now()))();
  assert.equal(requireSession(h.db, 2n, "personal-call").state, "active");
  assert.equal(controller.signal.aborted, true);
  assert.equal(personal.signal.aborted, false);
  assert.equal(balance(h.db, 2n, h.now()).meetingMsReserved, 30_000n);
});

test("organization call teardown leaves a pending personal brief untouched and ownership transfer is atomic", (t) => {
  const h = fixture(t);
  h.join(2n);
  const seat = h.paid();
  h.tx(() =>
    insertGrant(h.db, 2n, "personal", "pack", 100_000n, 3n, h.now(), null),
  );
  h.tx(() => assignSeat(h.db, 1n, h.org, 2n, h.now(), seat));
  h.tx(() => createSession(h.db, 2n, "organization-call", h.now(), h.funding));
  h.tx(() => reserveBrief(h.db, 2n, "personal-brief", h.now()));
  h.tx(() => unassignSeat(h.state, 1n, h.org, seat, h.now()))();
  assert.equal(balance(h.db, 2n, h.now()).briefsReserved, 1n);
  h.tx(() => settleBriefSuccess(h.db, 2n, "personal-brief", h.now()));
  assert.throws(
    () => h.tx(() => removeMember(h.state, 1n, h.org, 1n, h.now())),
    { code: "invalid_request" },
  );
  assert.throws(() => h.tx(() => transferOwner(h.db, 1n, h.org, 4n)), {
    status: 403,
  });
  h.tx(() => transferOwner(h.db, 1n, h.org, 2n));
  assert.throws(
    () =>
      h.tx(() =>
        inviteMember(h.db, 1n, h.org, "person-3@example.test", false, h.now()),
      ),
    { status: 403 },
  );
  h.tx(() => removeMember(h.state, 2n, h.org, 1n, h.now()))();
  assert.equal(organizationView(h.db, 1n, h.now()).organization, null);
  assert.equal(organizationView(h.db, 2n, h.now()).organization!.role, "owner");
});

test("late first assignment, same-holder renewal and retired or reversed windows obey budgets", (t) => {
  const h = fixture(t);
  h.join(2n);
  h.join(3n);
  const seat = h.paid();
  h.advance(10_000n);
  const first = h.tx(() => assignSeat(h.db, 1n, h.org, 2n, h.now(), seat));
  assert.equal(
    balance(h.db, 2n, h.now(), {
      kind: "organization",
      organizationId: h.org,
      assignmentId: BigInt(first.assignmentId),
    }).meetingMsAvailable,
    100_000n,
  );
  h.db.prepare("UPDATE seats SET status='retiring' WHERE id=?").run(seat);
  h.tx(() => createSession(h.db, 2n, "retiring-holder", h.now(), h.funding));
  h.tx(() => unassignSeat(h.state, 1n, h.org, seat, h.now()))();
  assert.throws(
    () => h.tx(() => assignSeat(h.db, 1n, h.org, 3n, h.now(), seat)),
    { code: "quota_exhausted" },
  );
  h.db.prepare("UPDATE seats SET status='active' WHERE id=?").run(seat);
  h.tx(() => assignSeat(h.db, 1n, h.org, 2n, h.now(), seat));
  h.advance(90_000n);
  assert.throws(
    () => h.tx(() => createSession(h.db, 2n, "expired", h.now(), h.funding)),
    { code: "no_seat" },
  );
  h.db
    .prepare(
      "INSERT INTO seat_periods(organization_id,seat_id,invoice_id,starts_ms,ends_ms,price_id,budget_ms,budget_briefs,financial_status) VALUES(?,?,'in_renewal',?,?,'price_monthly',200000,6,'paid')",
    )
    .run(h.org, seat, h.now(), h.now() + 200_000n);
  const period = h.db
    .prepare<[string], SeatPeriod>(
      "SELECT * FROM seat_periods WHERE invoice_id=?",
    )
    .get("in_renewal")!;
  const assignment = h.db
    .prepare<[bigint], Assignment>(
      "SELECT * FROM seat_assignments WHERE seat_id=? AND ended_at_ms IS NULL",
    )
    .get(seat)!;
  h.tx(() => grantForAssignment(h.db, assignment, period, h.now()));
  h.tx(() => grantForAssignment(h.db, assignment, period, h.now()));
  assertSeatConservation(h.db, period);
  assert.equal(
    balance(h.db, 2n, h.now(), {
      kind: "organization",
      organizationId: h.org,
      assignmentId: assignment.id,
    }).meetingMsAvailable,
    200_000n,
  );
  h.tx(() => unassignSeat(h.state, 1n, h.org, seat, h.now()))();
  h.db
    .prepare(
      "UPDATE seat_periods SET financial_status='reversed' WHERE invoice_id='in_renewal'",
    )
    .run();
  assert.throws(
    () => h.tx(() => assignSeat(h.db, 1n, h.org, 3n, h.now(), seat)),
    { code: "quota_exhausted" },
  );
});

test("pending invitations are bounded and seat grant budgets come only from the stored ledger", (t) => {
  const h = fixture(t);
  for (let i = 0; i < 50; i++)
    h.tx(() =>
      inviteMember(h.db, 1n, h.org, `invite-${i}@example.test`, false, h.now()),
    );
  assert.throws(
    () =>
      h.tx(() =>
        inviteMember(h.db, 1n, h.org, "overflow@example.test", false, h.now()),
      ),
    { code: "rate_limited" },
  );
  const seat = h.paid();
  const assigned = h.tx(() => assignSeat(h.db, 1n, h.org, 1n, h.now(), seat));
  const assignment = h.db
    .prepare<[bigint], Assignment>("SELECT * FROM seat_assignments WHERE id=?")
    .get(BigInt(assigned.assignmentId))!;
  const period = h.db
    .prepare<[bigint], SeatPeriod>("SELECT * FROM seat_periods WHERE seat_id=?")
    .get(seat)!;
  const id = h.tx(() =>
    grantForAssignment(
      h.db,
      assignment,
      { ...period, budget_ms: 9_000_000_000n },
      h.now(),
    ),
  );
  assert.equal(
    h.db
      .prepare<[bigint], { meeting_ms_total: bigint }>(
        "SELECT meeting_ms_total FROM allowance_grants WHERE id=?",
      )
      .get(id)!.meeting_ms_total,
    100_000n,
  );
});

test("a rolled-back unassignment cannot abort controllers or change the seat remainder", (t) => {
  const h = fixture(t);
  const seat = h.paid();
  const assigned = h.tx(() => assignSeat(h.db, 1n, h.org, 1n, h.now(), seat));
  const controller = new AbortController();
  h.state.cancellations.set(
    1n,
    new Map([
      [
        "pending",
        {
          controller,
          fundingAssignmentId: BigInt(assigned.assignmentId),
          sessionId: null,
        },
      ],
    ]),
  );
  assert.throws(
    () =>
      h.tx(() => {
        unassignSeat(h.state, 1n, h.org, seat, h.now());
        throw new Error("rollback after ledger mutation");
      }),
    /rollback/,
  );
  assert.equal(controller.signal.aborted, false);
  assert.equal(
    balance(h.db, 1n, h.now(), {
      kind: "organization",
      organizationId: h.org,
      assignmentId: BigInt(assigned.assignmentId),
    }).meetingMsAvailable,
    100_000n,
  );
});

test("settlement preserves the confirmed expiry interval but cannot debit a financially reversed seat period", (t) => {
  const h = fixture(t);
  const seat = h.paid(100_000n, 3n, h.now(), h.now() + 7_500n);
  h.tx(() => assignSeat(h.db, 1n, h.org, 1n, h.now(), seat));
  h.tx(() => createSession(h.db, 1n, "expiring", h.now(), h.funding));
  for (let i = 0; i < 15; i++) {
    onAudio(h.state, 1n, "expiring", "microphone", 16000, h.now());
    h.advance(500n);
  }
  h.tx(() => finishInterval(h.db, 1n, "expiring", "expired", h.now()));
  assert.equal(requireSession(h.db, 1n, "expiring").settled_ms, 7_500n);
  assert.equal(requireSession(h.db, 1n, "expiring").reserved_ms, 0n);
  h.db
    .prepare(
      "UPDATE managed_sessions SET state='stopped' WHERE local_session_id='expiring'",
    )
    .run();
  h.tx(() => unassignSeat(h.state, 1n, h.org, seat, h.now()))();
  const fresh = h.paid();
  h.tx(() => assignSeat(h.db, 1n, h.org, 1n, h.now(), fresh));
  h.tx(() => createSession(h.db, 1n, "reversed", h.now(), h.funding));
  onAudio(h.state, 1n, "reversed", "microphone", 16000, h.now());
  h.advance(500n);
  h.db
    .prepare(
      "UPDATE seat_periods SET financial_status='reversed' WHERE seat_id=?",
    )
    .run(fresh);
  h.tx(() => finishInterval(h.db, 1n, "reversed", "reversal", h.now()));
  assert.equal(requireSession(h.db, 1n, "reversed").settled_ms, 0n);
  assert.equal(requireSession(h.db, 1n, "reversed").reserved_ms, 0n);
});
