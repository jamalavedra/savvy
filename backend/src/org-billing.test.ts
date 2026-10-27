import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { openServiceDatabase } from "./db.js";
import { configuration } from "./config.js";
import { ServiceState } from "./state.js";
import { CATALOG } from "./catalog.js";
import { setCapability } from "./capability.js";
import { createOrganization, assignSeat, unassignSeat } from "./org.js";
import { bindCustomer, type StripeObject } from "./stripe.js";
import {
  fulfillSeatInvoice,
  applyOrganizationReversal,
} from "./org-billing.js";
import {
  balance,
  insertGrant,
  reserveBrief,
  settleBriefSuccess,
} from "./billing.js";
import { createSession, requireSession, onAudio } from "./sessions.js";

function fixture(t: TestContext) {
  const db = openServiceDatabase(":memory:");
  t.after(() => db.close());
  let now = 1_000_000n;
  const tx = <T>(fn: () => T) => db.transaction(fn).immediate();
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','owner',0),(2,'issuer','member',0)",
  ).run();
  tx(() => setCapability(db, "team_purchase_enabled", "1", now));
  const org = tx(() => createOrganization(db, 1n, "Team", now));
  db.prepare(
    "INSERT INTO organization_members VALUES(?,2,'member','member@example.test',0)",
  ).run(org);
  tx(() => bindCustomer(db, "organization", org, "cus_team"));
  db.prepare(
    "INSERT INTO organization_subscriptions(organization_id,stripe_subscription_id,stripe_item_id,price_id,status,quantity_next,updated_at_ms) VALUES(?,'sub_team','si_team','price_monthly','active',5,?)",
  ).run(org, now);
  db.prepare(
    "INSERT INTO organization_checkouts(organization_id,request_key,quantity,price_id,return_url,stripe_idempotency_key,stripe_session_id,stripe_subscription_id,state,created_at_ms,updated_at_ms) VALUES(?,'checkout',5,'price_monthly','https://savvy.test/team','fixed','cs_team','sub_team','payment_pending',?,?)",
  ).run(org, now, now);
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
  const invoice = (
    id = "in_first",
    quantity = 5,
    start = 1000,
    end = 2000,
  ): StripeObject => ({
    id,
    customer: "cus_team",
    status: "paid",
    currency: "usd",
    amount_paid: quantity * CATALOG.monthly.amountCents,
    billing_reason:
      id === "in_first" ? "subscription_create" : "subscription_cycle",
    lines: {
      data: [
        {
          pricing: { price_details: { price: "price_monthly" } },
          quantity,
          period: { start, end },
          parent: {
            subscription_item_details: {
              subscription_item: "si_team",
              proration: false,
            },
          },
        },
      ],
    },
    parent: { subscription_details: { subscription: "sub_team" } },
  });
  const pay = (value = invoice()) =>
    tx(() => fulfillSeatInvoice(state, org, value, CATALOG.monthly, now))();
  const reverse = (
    object: string,
    kind: "refund" | "dispute",
    status: "refunded" | "open" | "lost" | "won",
    invoice = "in_first",
  ) =>
    tx(() =>
      applyOrganizationReversal(state, org, invoice, object, kind, status, now),
    )();
  const assign = (account: bigint, seat: bigint) =>
    tx(() => assignSeat(db, 1n, org, account, now, seat));
  const funding = (assignment: string) => ({
    kind: "organization" as const,
    organizationId: org,
    assignmentId: BigInt(assignment),
  });
  return {
    db,
    state,
    tx,
    org,
    invoice,
    pay,
    reverse,
    assign,
    funding,
    now: () => now,
    advance: (ms: bigint) => {
      now += ms;
    },
  };
}

test("paid quantity creates one period per seat, grants only assigned holders and replays without new credit", (t) => {
  const h = fixture(t);
  h.pay();
  assert.equal(
    h.db.prepare<[], { n: bigint }>("SELECT count(*) AS n FROM seats").get()!.n,
    5n,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM seat_periods")
      .get()!.n,
    5n,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM allowance_grants")
      .get()!.n,
    0n,
  );
  const assigned = h.assign(1n, 1n);
  assert.equal(
    balance(h.db, 1n, h.now(), h.funding(assigned.assignmentId))
      .briefsAvailable,
    20n,
  );
  h.pay();
  h.pay();
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM allowance_grants")
      .get()!.n,
    1n,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM organization_payments",
      )
      .get()!.n,
    1n,
  );
  assert.equal(
    h.db
      .prepare<[], { state: string }>(
        "SELECT state FROM organization_checkouts",
      )
      .get()!.state,
    "complete",
  );
});

test("future invoices cannot change current capacity; duplicate windows and malformed invoices cannot grant", (t) => {
  const h = fixture(t);
  h.pay();
  assert.throws(() => h.pay(h.invoice("in_future", 3, 2000, 3000)), {
    code: "payment_pending",
  });
  assert.throws(() => h.pay(h.invoice("in_overlap", 3, 1000, 2000)), {
    code: "invalid_request",
  });
  for (const change of [
    { currency: "eur" },
    { parent: { subscription_details: { subscription: "sub_unknown" } } },
    {
      lines: {
        data: [
          {
            quantity: 0,
            pricing: { price_details: { price: "price_monthly" } },
          },
        ],
      },
    },
    {
      lines: {
        data: [{ quantity: 5, pricing: { price_details: { price: "wrong" } } }],
      },
    },
  ])
    assert.throws(() => h.pay({ ...h.invoice("in_bad"), ...change }), {
      code: "invalid_request",
    });
  assert.equal(
    h.db.prepare<[], { n: bigint }>("SELECT count(*) AS n FROM seats").get()!.n,
    5n,
  );
});

test("same-holder renewal changes periods without changing assignment and old refunds cannot stop the new call", (t) => {
  const h = fixture(t);
  h.pay();
  const assigned = h.assign(1n, 1n);
  h.db.prepare("UPDATE seats SET status='retiring' WHERE id IN (4,5)").run();
  h.advance(1_000_000n);
  h.pay(h.invoice("in_renewal", 3, 2000, 3000));
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM seats WHERE status<>'retired'",
      )
      .get()!.n,
    3n,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM seat_assignments")
      .get()!.n,
    1n,
  );
  assert.equal(
    balance(h.db, 1n, h.now(), h.funding(assigned.assignmentId))
      .briefsAvailable,
    20n,
  );
  h.tx(() =>
    createSession(h.db, 1n, "new-call", h.now(), {
      kind: "organization",
      organizationId: h.org.toString(),
    }),
  );
  h.reverse("ch_old", "refund", "refunded");
  assert.equal(requireSession(h.db, 1n, "new-call").state, "active");
  assert.equal(
    balance(h.db, 1n, h.now(), h.funding(assigned.assignmentId))
      .briefsAvailable,
    20n,
  );
});

test("refund-before-payment prevents vacant seats from granting and a dispute win never clears the refund", (t) => {
  const h = fixture(t);
  h.reverse("ch_refund", "refund", "refunded");
  h.pay();
  assert.throws(() => h.assign(1n, 1n), { code: "quota_exhausted" });
  h.reverse("dp_one", "dispute", "open");
  h.reverse("dp_one", "dispute", "won");
  assert.throws(() => h.assign(1n, 1n), { code: "quota_exhausted" });
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM allowance_grants")
      .get()!.n,
    0n,
  );
});

test("a won dispute before payment issues normal credit while A-to-B-to-A restoration preserves spent briefs", (t) => {
  const h = fixture(t);
  h.reverse("dp_cleared", "dispute", "open");
  h.reverse("dp_cleared", "dispute", "won");
  h.pay();
  let a = h.assign(1n, 1n);
  h.tx(() =>
    reserveBrief(h.db, 1n, "a-used", h.now(), h.funding(a.assignmentId)),
  );
  h.tx(() => settleBriefSuccess(h.db, 1n, "a-used", h.now()));
  h.tx(() => unassignSeat(h.state, 1n, h.org, 1n, h.now()))();
  const b = h.assign(2n, 1n);
  h.tx(() =>
    reserveBrief(h.db, 2n, "b-used", h.now(), h.funding(b.assignmentId)),
  );
  h.tx(() => settleBriefSuccess(h.db, 2n, "b-used", h.now()));
  h.tx(() => unassignSeat(h.state, 1n, h.org, 1n, h.now()))();
  a = h.assign(1n, 1n);
  h.reverse("dp_current", "dispute", "open");
  assert.throws(() => balance(h.db, 1n, h.now(), h.funding(a.assignmentId)), {
    code: "no_seat",
  });
  h.reverse("dp_current", "dispute", "won");
  assert.equal(
    balance(h.db, 1n, h.now(), h.funding(a.assignmentId)).briefsAvailable,
    18n,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM allowance_grants WHERE seat_period_id=1 AND revoked=0",
      )
      .get()!.n,
    1n,
  );
  assert.throws(
    () =>
      h.tx(() =>
        applyOrganizationReversal(
          h.state,
          h.org,
          "in_other",
          "dp_current",
          "dispute",
          "won",
          h.now(),
        ),
      ),
    { code: "invalid_request" },
  );
});

test("a zero-cost paid invoice funds allowances and one disabled holder cannot block renewal for everyone", (t) => {
  const h = fixture(t);
  h.pay({ ...h.invoice(), amount_paid: 0 });
  h.assign(1n, 1n);
  const b = h.assign(2n, 2n);
  h.db.prepare("UPDATE accounts SET disabled=1 WHERE id=1").run();
  h.advance(1_000_000n);
  h.pay(h.invoice("in_renewal", 5, 2000, 3000));
  assert.equal(
    balance(h.db, 2n, h.now(), h.funding(b.assignmentId)).briefsAvailable,
    20n,
  );
  h.db.prepare("UPDATE accounts SET disabled=0 WHERE id=1").run();
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM allowance_grants WHERE origin LIKE '%period:%'",
      )
      .get()!.n,
    4n,
  );
});

test("invoice reversal settles delivered org calls and aborts only affected work while preserving personal credit", (t) => {
  const h = fixture(t);
  h.pay();
  const owner = h.assign(1n, 1n),
    member = h.assign(2n, 2n);
  const choice = {
    kind: "organization" as const,
    organizationId: h.org.toString(),
  };
  h.tx(() => createSession(h.db, 1n, "owner-call", h.now(), choice));
  h.tx(() => createSession(h.db, 2n, "member-call", h.now(), choice));
  h.tx(() =>
    insertGrant(h.db, 1n, "own-pack", "pack", 100_000n, 2n, h.now(), null),
  );
  h.tx(() => reserveBrief(h.db, 1n, "own-brief", h.now()));
  h.tx(() =>
    reserveBrief(
      h.db,
      2n,
      "team-brief",
      h.now(),
      h.funding(member.assignmentId),
    ),
  );
  const personal = new AbortController(),
    organization = new AbortController();
  h.state.cancellations.set(
    1n,
    new Map([
      [
        "own-brief",
        { controller: personal, fundingAssignmentId: null, sessionId: null },
      ],
    ]),
  );
  h.state.cancellations.set(
    2n,
    new Map([
      [
        "team-brief",
        {
          controller: organization,
          fundingAssignmentId: BigInt(member.assignmentId),
          sessionId: null,
        },
      ],
    ]),
  );
  for (let i = 0; i < 10; i++) {
    onAudio(h.state, 1n, "owner-call", "microphone", 16000, h.now());
    onAudio(h.state, 2n, "member-call", "microphone", 16000, h.now());
    h.advance(500n);
  }
  h.reverse("ch_partial", "refund", "refunded");
  assert.equal(requireSession(h.db, 1n, "owner-call").state, "stopped");
  assert.equal(requireSession(h.db, 2n, "member-call").settled_ms, 5_000n);
  assert.equal(requireSession(h.db, 1n, "owner-call").settled_ms, 5_000n);
  assert.equal(balance(h.db, 1n, h.now()).briefsReserved, 1n);
  assert.equal(personal.signal.aborted, false);
  assert.equal(organization.signal.aborted, true);
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM seat_periods WHERE financial_status='reversed'",
      )
      .get()!.n,
    5n,
  );
  assert.throws(
    () => balance(h.db, 1n, h.now(), h.funding(owner.assignmentId)),
    { code: "no_seat" },
  );
  h.tx(() => settleBriefSuccess(h.db, 1n, "own-brief", h.now()));
  h.reverse("ch_partial", "refund", "refunded");
  assert.equal(requireSession(h.db, 1n, "owner-call").settled_ms, 5_000n);
});
