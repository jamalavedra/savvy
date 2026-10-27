import type { ServiceState } from "./state.js";
import { ApiError } from "./errors.js";
import type { Offer } from "./catalog.js";
import { MS_PER_HOUR, releaseBrief } from "./billing.js";
import {
  assertSeatConservation,
  endAssignment,
  grantForAssignment,
  type Assignment,
  type SeatPeriod,
} from "./org.js";
import { finishInterval, type SessionRow } from "./sessions.js";
import {
  field,
  integer,
  resolveCustomer,
  stripeId,
  type StripeObject,
} from "./stripe.js";

function transactionRequired(state: ServiceState) {
  if (!state.db.inTransaction)
    throw new Error("Seat invoice changes require a transaction");
}
export function invoiceIsReversed(
  state: ServiceState,
  org: bigint,
  invoice: string,
) {
  return !!state.db
    .prepare(
      `SELECT 1 FROM organization_reversals WHERE organization_id=? AND invoice_id=?
    AND ((kind='refund' AND status='refunded') OR (kind='dispute' AND status IN ('open','lost'))) LIMIT 1`,
    )
    .get(org, invoice);
}

export function reconcileSeats(
  state: ServiceState,
  org: bigint,
  quantity: number,
  now: bigint,
) {
  transactionRequired(state);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 50)
    throw new ApiError("invalid_request", "invalid paid seat quantity");
  const db = state.db,
    cleanup: (() => void)[] = [];
  const current = db
    .prepare<[bigint], { id: bigint; occupied: bigint }>(
      `SELECT s.id,EXISTS(SELECT 1 FROM seat_assignments a WHERE a.seat_id=s.id AND a.ended_at_ms IS NULL) AS occupied
    FROM seats s WHERE s.organization_id=? AND s.status<>'retired'
    ORDER BY (s.status='retiring') DESC,occupied,s.seat_number DESC`,
    )
    .all(org);
  // The paid quantity controls this period, even if a newer change targets the following renewal.
  const retire = current.slice(0, Math.max(0, current.length - quantity));
  for (const seat of retire) {
    const assignment = db
      .prepare<[bigint], { id: bigint }>(
        "SELECT id FROM seat_assignments WHERE seat_id=? AND ended_at_ms IS NULL",
      )
      .get(seat.id);
    if (assignment)
      cleanup.push(endAssignment(state, assignment.id, "retired", now));
    db.prepare("UPDATE seats SET status='retired' WHERE id=?").run(seat.id);
  }
  const count = current.length - retire.length;
  for (let n = count; n < quantity; n++)
    db.prepare(
      "INSERT INTO seats(organization_id,seat_number,status,created_at_ms) VALUES(?,COALESCE((SELECT max(seat_number)+1 FROM seats WHERE organization_id=?),1),'active',?)",
    ).run(org, org, now);
  return () => {
    for (const fn of cleanup) fn();
  };
}

export function fulfillSeatInvoice(
  state: ServiceState,
  org: bigint,
  invoice: StripeObject,
  offer: Offer,
  now: bigint,
) {
  transactionRequired(state);
  const db = state.db,
    id = stripeId(invoice),
    customer = stripeId(invoice.customer),
    owner = resolveCustomer(db, customer);
  const lines = field(invoice, "lines", "data");
  if (
    !owner ||
    owner.owner_kind !== "organization" ||
    owner.owner_id !== org ||
    invoice.status !== "paid" ||
    invoice.currency !== "usd" ||
    !["subscription_create", "subscription_cycle"].includes(
      String(invoice.billing_reason),
    ) ||
    !Array.isArray(lines) ||
    lines.length !== 1 ||
    field(invoice, "lines", "has_more") === true
  )
    throw new ApiError(
      "invalid_request",
      "invoice is not an eligible organization payment",
    );
  const line = lines[0],
    quantity = field(line, "quantity"),
    price = stripeId(field(line, "pricing", "price_details", "price"));
  if (
    typeof quantity !== "number" ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 50 ||
    field(line, "parent", "subscription_item_details", "proration") === true
  )
    throw new ApiError(
      "invalid_request",
      "organization invoice product mismatch",
    );
  const starts =
      integer(field(line, "period", "start"), "missing paid period") * 1000n,
    ends = integer(field(line, "period", "end"), "missing paid period") * 1000n;
  if (starts < 0n || ends <= starts || ends > 9_223_372_036_854_775_807n)
    throw new ApiError("invalid_request", "invalid paid seat period");
  const subscription = stripeId(
    field(invoice, "parent", "subscription_details", "subscription"),
  );
  const known = db
    .prepare<
      [bigint],
      {
        stripe_subscription_id: string;
        stripe_item_id: string | null;
        price_id: string;
        paid_through_ms: bigint | null;
      }
    >("SELECT * FROM organization_subscriptions WHERE organization_id=?")
    .get(org);
  const initial = db
    .prepare<
      [bigint, string],
      { quantity: bigint; price_id: string; stripe_item_id: string | null }
    >(
      "SELECT quantity,price_id,stripe_item_id FROM organization_checkouts WHERE organization_id=? AND stripe_subscription_id=?",
    )
    .get(org, subscription);
  const isCurrent = known?.stripe_subscription_id === subscription;
  const item =
    initial?.stripe_item_id ?? (isCurrent ? known?.stripe_item_id : null);
  if (
    !initial ||
    initial.price_id !== price ||
    !item ||
    stripeId(
      field(line, "parent", "subscription_item_details", "subscription_item"),
    ) !== item ||
    (invoice.billing_reason === "subscription_create" &&
      initial.quantity !== BigInt(quantity)) ||
    (!isCurrent && ends > now)
  )
    throw new ApiError(
      "invalid_request",
      "organization invoice does not match its verified subscription and checkout",
    );
  if (starts > now)
    throw new ApiError(
      "payment_pending",
      "the paid seat period begins in the future; reconciliation will apply it at that time",
    );
  const amount = integer(invoice.amount_paid, "missing invoice amount");
  if (
    amount < 0n ||
    offer.currency !== "usd" ||
    !Number.isSafeInteger(offer.hours) ||
    offer.hours < 0 ||
    !Number.isSafeInteger(offer.briefs) ||
    offer.briefs < 0
  )
    throw new ApiError(
      "invalid_request",
      "invalid organization payment allowance",
    );
  const existing = db
    .prepare<[bigint, string], SeatPeriod>(
      "SELECT * FROM seat_periods WHERE organization_id=? AND invoice_id=?",
    )
    .all(org, id);
  if (existing.length) {
    if (
      existing.length !== quantity ||
      existing.some((p) => p.starts_ms !== starts || p.ends_ms !== ends)
    )
      throw new ApiError("invalid_request", "paid invoice identity changed");
    for (const period of existing) assertSeatConservation(db, period);
    return () => {};
  }
  if (
    db
      .prepare(
        "SELECT 1 FROM seat_periods WHERE organization_id=? AND starts_ms<? AND ends_ms>? AND invoice_id<>? LIMIT 1",
      )
      .get(org, ends, starts, id)
  )
    throw new ApiError("invalid_request", "paid organization periods overlap");
  const current =
    isCurrent &&
    ends > now &&
    (known!.paid_through_ms === null || ends >= known!.paid_through_ms);
  const cleanup = current
    ? reconcileSeats(state, org, quantity, now)
    : () => {};
  const seats = current
    ? db
        .prepare<[bigint], { id: bigint }>(
          "SELECT id FROM seats WHERE organization_id=? AND status<>'retired' ORDER BY seat_number",
        )
        .all(org)
    : db
        .prepare<[bigint, number], { id: bigint }>(
          "SELECT id FROM seats WHERE organization_id=? ORDER BY seat_number LIMIT ?",
        )
        .all(org, quantity);
  while (seats.length < quantity) {
    const created = db
      .prepare(
        "INSERT INTO seats(organization_id,seat_number,status,created_at_ms) VALUES(?,COALESCE((SELECT max(seat_number)+1 FROM seats WHERE organization_id=?),1),'retired',?)",
      )
      .run(org, org, now);
    seats.push({ id: BigInt(created.lastInsertRowid) });
  }
  const reversed = invoiceIsReversed(state, org, id);
  for (const seat of seats) {
    const periodId = BigInt(
      db
        .prepare(
          "INSERT INTO seat_periods(organization_id,seat_id,invoice_id,starts_ms,ends_ms,price_id,budget_ms,budget_briefs,financial_status) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          org,
          seat.id,
          id,
          starts,
          ends,
          price,
          BigInt(offer.hours) * MS_PER_HOUR,
          offer.briefs,
          reversed ? "reversed" : "paid",
        ).lastInsertRowid,
    );
    const period = db
      .prepare<[bigint], SeatPeriod>("SELECT * FROM seat_periods WHERE id=?")
      .get(periodId)!;
    if (current && !reversed) {
      const assignment = db
        .prepare<[bigint], Assignment>(
          "SELECT * FROM seat_assignments WHERE seat_id=? AND ended_at_ms IS NULL",
        )
        .get(seat.id);
      if (assignment) grantForAssignment(db, assignment, period, now);
    }
    assertSeatConservation(db, period);
  }
  db.prepare(
    "INSERT INTO organization_payments(stripe_object_id,organization_id,invoice_id,amount_cents,created_ms) VALUES(?,?,?,?,?)",
  ).run(id, org, id, amount, now);
  db.prepare(
    "UPDATE organization_subscriptions SET paid_through_ms=max(COALESCE(paid_through_ms,0),?),updated_at_ms=? WHERE organization_id=? AND stripe_subscription_id=?",
  ).run(ends, now, org, subscription);
  db.prepare(
    "UPDATE organization_checkouts SET state='complete',updated_at_ms=? WHERE organization_id=? AND stripe_subscription_id=?",
  ).run(now, org, subscription);
  return cleanup;
}

export function applyOrganizationReversal(
  state: ServiceState,
  org: bigint,
  invoice: string,
  object: string,
  kind: "refund" | "dispute",
  status: "refunded" | "open" | "lost" | "won" | "closed",
  now: bigint,
) {
  transactionRequired(state);
  stripeId(invoice);
  stripeId(object);
  if (
    (kind === "refund" && status !== "refunded") ||
    (kind === "dispute" && status === "refunded")
  )
    throw new ApiError("invalid_request", "invalid payment reversal state");
  const db = state.db;
  const payment = db
    .prepare<[string], { organization_id: bigint }>(
      "SELECT organization_id FROM organization_payments WHERE stripe_object_id=?",
    )
    .get(invoice);
  if (payment && payment.organization_id !== org)
    throw new ApiError(
      "invalid_request",
      "payment reversal belongs to another organization",
    );
  const previous = db
    .prepare<
      [string],
      { organization_id: bigint | null; invoice_id: string; kind: string }
    >(
      "SELECT organization_id,invoice_id,kind FROM organization_reversals WHERE stripe_object_id=?",
    )
    .get(object);
  if (
    previous &&
    (previous.organization_id !== org ||
      previous.invoice_id !== invoice ||
      previous.kind !== kind)
  )
    throw new ApiError(
      "invalid_request",
      "payment reversal belongs to another invoice",
    );
  db.prepare(
    "INSERT INTO organization_reversals(stripe_object_id,organization_id,invoice_id,kind,status,created_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(stripe_object_id) DO UPDATE SET status=excluded.status",
  ).run(object, org, invoice, kind, status, now);
  const reversed = invoiceIsReversed(state, org, invoice);
  const sessions = reversed
    ? db
        .prepare<[bigint, string], SessionRow>(
          `SELECT DISTINCT ms.* FROM managed_sessions ms JOIN session_reservations r ON r.session_id=ms.id
    JOIN allowance_grants g ON g.id=r.grant_id JOIN seat_periods p ON p.id=g.seat_period_id
    WHERE p.organization_id=? AND p.invoice_id=? AND ms.state IN ('active','paused')`,
        )
        .all(org, invoice)
    : [];
  const keys = new Map<bigint, Set<string>>();
  function release(account: bigint, key: string) {
    releaseBrief(db, account, key, now);
    let set = keys.get(account);
    if (!set) {
      set = new Set();
      keys.set(account, set);
    }
    set.add(key);
  }
  for (const session of sessions) {
    const live = state.sessions.get(session.id);
    const end = live
      ? live.deliveredUntilMs < now
        ? live.deliveredUntilMs
        : now
      : (session.billable_since_ms ?? now);
    finishInterval(
      db,
      session.account_id,
      session.local_session_id,
      "seat_revoked",
      end,
    );
    db.prepare(
      "UPDATE managed_sessions SET state='stopped',lease_version=lease_version+1,lease_expires_ms=NULL,updated_at_ms=? WHERE id=?",
    ).run(now, session.id);
    for (const [key, entry] of state.cancellations.get(session.account_id) ??
      [])
      if (entry.sessionId === session.id) release(session.account_id, key);
  }
  if (reversed)
    for (const row of db
      .prepare<[bigint, string], { account_id: bigint; request_key: string }>(
        `SELECT r.account_id,r.request_key FROM provider_requests r JOIN allowance_grants g ON g.id=r.grant_id JOIN seat_periods p ON p.id=g.seat_period_id WHERE p.organization_id=? AND p.invoice_id=? AND r.state='pending'`,
      )
      .all(org, invoice))
      release(row.account_id, row.request_key);
  const periods = db
    .prepare<[bigint, string], SeatPeriod>(
      "SELECT * FROM seat_periods WHERE organization_id=? AND invoice_id=?",
    )
    .all(org, invoice);
  for (const period of periods) {
    db.prepare("UPDATE seat_periods SET financial_status=? WHERE id=?").run(
      reversed ? "reversed" : "paid",
      period.id,
    );
    if (reversed)
      db.prepare(
        "UPDATE allowance_grants SET revoked=1,revocation_reason='reversal' WHERE seat_period_id=? AND revoked=0",
      ).run(period.id);
    else {
      db.prepare(
        `UPDATE allowance_grants SET revoked=0,revocation_reason=NULL WHERE seat_period_id=? AND revocation_reason='reversal' AND valid_from_ms<=? AND valid_until_ms>?
        AND EXISTS(SELECT 1 FROM seat_assignments a JOIN seats s ON s.id=a.seat_id JOIN organization_members m ON m.organization_id=s.organization_id AND m.account_id=a.account_id
          WHERE a.id=allowance_grants.seat_assignment_id AND a.account_id=allowance_grants.account_id AND a.ended_at_ms IS NULL AND s.status<>'retired')`,
      ).run(period.id, now, now);
      if (period.starts_ms <= now && period.ends_ms > now) {
        const assignment = db
          .prepare<[bigint], Assignment>(
            "SELECT * FROM seat_assignments WHERE seat_id=? AND ended_at_ms IS NULL",
          )
          .get(period.seat_id);
        if (assignment)
          grantForAssignment(
            db,
            assignment,
            { ...period, financial_status: "paid" },
            now,
          );
      }
    }
    assertSeatConservation(db, period);
  }
  return () => {
    for (const session of sessions) state.sessions.delete(session.id);
    for (const [account, requests] of keys)
      for (const key of requests)
        state.cancellations.get(account)?.get(key)?.controller.abort();
  };
}
