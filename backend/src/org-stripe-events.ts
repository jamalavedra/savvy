import type { ServiceState } from "./state.js";
import { reserveAttempt } from "./billing.js";
import { ApiError } from "./errors.js";
import { recoverPrice } from "./catalog.js";
import {
  applyOrganizationReversal,
  fulfillSeatInvoice,
} from "./org-billing.js";
import {
  applyRetirementPlan,
  findCheckout,
  organizationCustomer,
  recordOrganizationCheckout,
  subscriptionDetails,
  type Checkout,
} from "./org-stripe.js";
import {
  acquireBilling,
  billingDeadline,
  field,
  get,
  integer,
  post,
  resolveCustomer,
  stripeId,
  type StripeObject,
} from "./stripe.js";

interface Subscription {
  stripe_subscription_id: string;
  stripe_item_id: string | null;
  price_id: string;
  quantity_next: bigint;
  status: string;
  checked_at_ms: bigint;
}
interface QuantityOperation {
  id: bigint;
  quantity: bigint;
  retire_seat_ids: string;
  stripe_subscription_id: string;
  stripe_item_id: string;
  price_id: string;
  stripe_idempotency_key: string;
  created_at_ms: bigint;
}
function requireLock(state: ServiceState, org: bigint) {
  if (!state.billingInFlight.has(`org:${org}`))
    throw new Error("Organization reconciliation requires its billing lock");
}
function verifyCustomer(state: ServiceState, org: bigint, value: unknown) {
  const customer = stripeId(value),
    owner = resolveCustomer(state.db, customer);
  if (!owner || owner.owner_kind !== "organization" || owner.owner_id !== org)
    throw new ApiError(
      "invalid_request",
      "organization billing customer mismatch",
    );
  return customer;
}
async function resolveCheckout(
  state: ServiceState,
  org: bigint,
  subscription: string,
) {
  const customer = organizationCustomer(state, org);
  if (!customer)
    throw new ApiError(
      "payment_pending",
      "organization customer needs reconciliation",
    );
  let known = state.db
    .prepare<[bigint, string], Checkout>(
      "SELECT * FROM organization_checkouts WHERE organization_id=? AND stripe_subscription_id=?",
    )
    .get(org, subscription);
  if (known) return known;
  const pending = state.db
    .prepare<[bigint], Checkout>(
      "SELECT * FROM organization_checkouts WHERE organization_id=? AND state IN ('pending','payment_pending','unknown')",
    )
    .all(org);
  for (const intent of pending) {
    const session = intent.stripe_session_id
      ? await get(
          state,
          `checkout/sessions/${stripeId(intent.stripe_session_id)}?expand[]=line_items`,
        )
      : await findCheckout(state, intent, customer);
    if (session) recordOrganizationCheckout(state, intent, customer, session);
  }
  known = state.db
    .prepare<[bigint, string], Checkout>(
      "SELECT * FROM organization_checkouts WHERE organization_id=? AND stripe_subscription_id=?",
    )
    .get(org, subscription);
  const unresolved = state.db
    .prepare<[bigint], { n: bigint }>(
      "SELECT count(*) AS n FROM organization_checkouts WHERE organization_id=? AND stripe_subscription_id IS NULL AND state IN ('pending','payment_pending','unknown')",
    )
    .get(org)!.n;
  if (!known)
    throw new ApiError(
      unresolved > 0n ? "payment_pending" : "invalid_request",
      "organization subscription has no recognized checkout",
    );
  return known;
}
function externalRetirement(
  state: ServiceState,
  org: bigint,
  quantity: number,
) {
  const seats = state.db
    .prepare<[bigint], { id: bigint; occupied: bigint }>(
      `SELECT s.id,EXISTS(SELECT 1 FROM seat_assignments a WHERE a.seat_id=s.id AND a.ended_at_ms IS NULL) AS occupied
    FROM seats s WHERE s.organization_id=? AND s.status<>'retired' ORDER BY occupied,s.seat_number DESC`,
    )
    .all(org);
  return seats
    .slice(0, Math.max(0, seats.length - quantity))
    .map((s) => s.id.toString());
}
function operationRetirement(
  state: ServiceState,
  org: bigint,
  operation: QuantityOperation,
) {
  const raw: unknown = JSON.parse(operation.retire_seat_ids);
  if (
    !Array.isArray(raw) ||
    raw.some((id) => typeof id !== "string" || !/^[1-9][0-9]*$/.test(id))
  )
    throw new Error("Invalid persisted quantity retirement plan");
  const current = state.db
    .prepare<[bigint], { id: bigint }>(
      "SELECT id FROM seats WHERE organization_id=? AND status<>'retired'",
    )
    .all(org);
  // A renewal may already have applied this operation's retired slots before recovery.
  const ids = raw.filter((id) => current.some((s) => s.id.toString() === id));
  if (ids.length !== Math.max(0, current.length - Number(operation.quantity)))
    return externalRetirement(state, org, Number(operation.quantity));
  return ids;
}
async function synchronizeSubscription(
  state: ServiceState,
  org: bigint,
  value: StripeObject,
) {
  requireLock(state, org);
  const customer = verifyCustomer(state, org, value.customer),
    id = stripeId(value);
  const intent = await resolveCheckout(state, org, id);
  let current = value,
    details = subscriptionDetails(current, customer, intent.price_id, id);
  const status = current.status;
  if (
    typeof status !== "string" ||
    ![
      "incomplete",
      "incomplete_expired",
      "trialing",
      "active",
      "past_due",
      "canceled",
      "unpaid",
      "paused",
    ].includes(status)
  )
    throw new ApiError("provider_unavailable", "invalid subscription status");
  const snapshot = state.db
    .prepare<[bigint], { stripe_item_id: string | null }>(
      "SELECT stripe_item_id FROM organization_checkouts WHERE id=?",
    )
    .get(intent.id)!;
  if (snapshot.stripe_item_id && snapshot.stripe_item_id !== details.item)
    throw new ApiError(
      "invalid_request",
      "subscription item changed from its purchased identity",
    );
  state.db
    .prepare(
      "UPDATE organization_checkouts SET stripe_item_id=? WHERE id=? AND stripe_item_id IS NULL",
    )
    .run(details.item, intent.id);
  const existing = state.db
    .prepare<[bigint], Subscription>(
      "SELECT * FROM organization_subscriptions WHERE organization_id=?",
    )
    .get(org);
  if (existing && existing.stripe_subscription_id !== id)
    return { current, intent, details, historical: true };
  const operation = state.db
    .prepare<[bigint], QuantityOperation>(
      "SELECT * FROM organization_quantity_changes WHERE organization_id=? AND state IN ('pending','unknown')",
    )
    .get(org);
  let ended = status === "canceled" || status === "incomplete_expired";
  if (
    operation &&
    !ended &&
    operation.stripe_subscription_id === id &&
    operation.stripe_item_id === details.item &&
    operation.price_id === intent.price_id &&
    details.quantity !== Number(operation.quantity) &&
    state.clock() - operation.created_at_ms < 23n * 3_600_000n
  ) {
    await post(state, `subscriptions/${id}`, operation.stripe_idempotency_key, [
      ["items[0][id]", operation.stripe_item_id],
      ["items[0][quantity]", operation.quantity.toString()],
      ["proration_behavior", "none"],
    ]);
    current = await get(state, `subscriptions/${id}`);
    details = subscriptionDetails(current, customer, intent.price_id, id);
    ended =
      current.status === "canceled" || current.status === "incomplete_expired";
  }
  state.db
    .transaction(() => {
      const now = state.clock();
      state.db
        .prepare(
          "INSERT INTO organization_subscriptions(organization_id,stripe_subscription_id,stripe_item_id,price_id,status,quantity_next,cancel_at_period_end,updated_at_ms,checked_at_ms) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET stripe_item_id=excluded.stripe_item_id,status=excluded.status,quantity_next=excluded.quantity_next,cancel_at_period_end=excluded.cancel_at_period_end,updated_at_ms=excluded.updated_at_ms,checked_at_ms=excluded.checked_at_ms",
        )
        .run(
          org,
          id,
          details.item,
          intent.price_id,
          String(current.status),
          details.quantity,
          current.cancel_at_period_end === true ? 1 : 0,
          now,
          now,
        );
      if (ended) {
        applyRetirementPlan(state, org, []);
        state.db
          .prepare(
            "UPDATE organization_quantity_changes SET state='failed' WHERE organization_id=? AND stripe_subscription_id=? AND state IN ('pending','unknown')",
          )
          .run(org, id);
        state.db
          .prepare(
            "UPDATE organization_checkouts SET state='failed',updated_at_ms=? WHERE organization_id=? AND stripe_subscription_id=? AND state<>'complete'",
          )
          .run(now, org, id);
      } else if (
        operation &&
        operation.stripe_subscription_id === id &&
        details.quantity === Number(operation.quantity)
      ) {
        applyRetirementPlan(
          state,
          org,
          operationRetirement(state, org, operation),
        );
        state.db
          .prepare(
            "UPDATE organization_quantity_changes SET state='applied' WHERE id=?",
          )
          .run(operation.id);
      } else if (
        !operation &&
        existing &&
        existing.quantity_next !== BigInt(details.quantity)
      ) {
        applyRetirementPlan(
          state,
          org,
          externalRetirement(state, org, details.quantity),
        );
        state.db
          .prepare(
            "UPDATE organization_subscriptions SET external_change=1 WHERE organization_id=?",
          )
          .run(org);
      }
    })
    .immediate();
  return { current, intent, details, historical: false };
}
async function applyInvoice(
  state: ServiceState,
  org: bigint,
  invoice: StripeObject,
  canonical?: StripeObject,
) {
  requireLock(state, org);
  verifyCustomer(state, org, invoice.customer);
  if (invoice.status !== "paid") return;
  const sub = stripeId(
    field(invoice, "parent", "subscription_details", "subscription"),
  );
  const current =
    canonical && stripeId(canonical) === sub
      ? canonical
      : await get(state, `subscriptions/${sub}`);
  const synchronized = await synchronizeSubscription(state, org, current);
  const price = stripeId(
    field(invoice, "lines", "data", 0, "pricing", "price_details", "price"),
  );
  if (price !== synchronized.intent.price_id)
    throw new ApiError(
      "invalid_request",
      "organization invoice price mismatch",
    );
  const offer = await recoverPrice(state, price, "monthly");
  const cleanup = state.db
    .transaction(() =>
      fulfillSeatInvoice(state, org, invoice, offer, state.clock()),
    )
    .immediate();
  cleanup();
}
async function invoiceForCharge(
  state: ServiceState,
  org: bigint,
  charge: StripeObject,
) {
  verifyCustomer(state, org, charge.customer);
  if (charge.invoice != null) return stripeId(charge.invoice);
  const payment = stripeId(charge.payment_intent);
  const known = state.db
    .prepare<[string], { invoice_id: string; organization_id: bigint }>(
      "SELECT invoice_id,organization_id FROM organization_payments WHERE stripe_object_id=?",
    )
    .get(payment);
  if (known && known.organization_id !== org)
    throw new ApiError(
      "invalid_request",
      "invoice payment belongs to another organization",
    );
  if (known) return known.invoice_id;
  const invoices = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    const query = new URLSearchParams({
      "payment[type]": "payment_intent",
      "payment[payment_intent]": payment,
      limit: "100",
    });
    if (cursor) query.set("starting_after", cursor);
    const payments = await get(state, `invoice_payments?${query}`);
    if (!Array.isArray(payments.data))
      throw new ApiError(
        "provider_unavailable",
        "invalid invoice payment response",
      );
    for (const p of payments.data) invoices.add(stripeId(field(p, "invoice")));
    if (payments.has_more !== true) {
      if (invoices.size !== 1)
        throw new ApiError(
          "invalid_request",
          "charge does not identify one organization invoice",
        );
      const invoice = [...invoices][0];
      state.db
        .prepare(
          "INSERT INTO organization_payments(stripe_object_id,organization_id,invoice_id,amount_cents,created_ms) VALUES(?,?,?,0,?) ON CONFLICT(stripe_object_id) DO NOTHING",
        )
        .run(payment, org, invoice, state.clock());
      return invoice;
    }
    const next = stripeId(payments.data.at(-1));
    if (!payments.data.length || next === cursor)
      throw new ApiError(
        "provider_unavailable",
        "invoice payment pagination did not advance",
      );
    cursor = next;
  }
  throw new ApiError(
    "payment_pending",
    "invoice payment mapping needs further reconciliation",
  );
}

export async function processOrganizationEvent(
  state: ServiceState,
  org: bigint,
  kind: string,
  id: string,
) {
  const release = acquireBilling(state, `org:${org}`);
  try {
    if (kind.startsWith("checkout.session.")) {
      const session = await get(
          state,
          `checkout/sessions/${stripeId(id)}?expand[]=line_items`,
        ),
        customer = verifyCustomer(state, org, session.customer);
      const key = field(session, "metadata", "savvy_key");
      const row = state.db
        .prepare<[bigint, string, string | null], Checkout>(
          "SELECT * FROM organization_checkouts WHERE organization_id=? AND (stripe_session_id=? OR request_key=?)",
        )
        .get(org, id, typeof key === "string" ? key : null);
      if (!row)
        throw new ApiError(
          "invalid_request",
          "unrecognized organization checkout",
        );
      recordOrganizationCheckout(state, row, customer, session);
      if (
        kind === "checkout.session.async_payment_failed" &&
        session.payment_status !== "paid"
      )
        state.db
          .prepare(
            "UPDATE organization_checkouts SET state='failed' WHERE id=? AND state<>'complete'",
          )
          .run(row.id);
      if (session.subscription != null && session.status === "complete") {
        let canonical = await get(
          state,
          `subscriptions/${stripeId(session.subscription)}`,
        );
        canonical = (await synchronizeSubscription(state, org, canonical))
          .current;
        if (canonical.latest_invoice != null)
          await applyInvoice(
            state,
            org,
            await get(state, `invoices/${stripeId(canonical.latest_invoice)}`),
            canonical,
          );
      }
    } else if (kind.startsWith("invoice."))
      await applyInvoice(
        state,
        org,
        await get(state, `invoices/${stripeId(id)}`),
      );
    else if (kind.startsWith("customer.subscription.")) {
      let canonical = await get(state, `subscriptions/${stripeId(id)}`);
      canonical = (await synchronizeSubscription(state, org, canonical))
        .current;
      if (canonical.latest_invoice != null)
        await applyInvoice(
          state,
          org,
          await get(state, `invoices/${stripeId(canonical.latest_invoice)}`),
          canonical,
        );
    } else if (
      kind === "charge.refunded" ||
      kind.startsWith("charge.dispute.")
    ) {
      const dispute = kind.startsWith("charge.dispute.")
        ? await get(state, `disputes/${stripeId(id)}`)
        : undefined;
      const charge = await get(
        state,
        `charges/${dispute ? stripeId(dispute.charge) : stripeId(id)}`,
      );
      const invoice = await invoiceForCharge(state, org, charge),
        amount = integer(charge.amount_refunded, "invalid refunded amount");
      if (amount < 0n)
        throw new ApiError("invalid_request", "invalid refunded amount");
      let status: "won" | "closed" | "open" | "lost" | undefined;
      if (dispute) {
        if (dispute.status === "won") status = "won";
        else if (dispute.status === "warning_closed") status = "closed";
        else if (dispute.status === "lost") status = "lost";
        else if (
          [
            "needs_response",
            "under_review",
            "warning_needs_response",
            "warning_under_review",
          ].includes(String(dispute.status))
        )
          status = "open";
        else
          throw new ApiError(
            "provider_unavailable",
            "unrecognized dispute status",
          );
      }
      const cleanup = state.db
        .transaction(() => {
          const after: (() => void)[] = [];
          if (amount > 0n)
            after.push(
              applyOrganizationReversal(
                state,
                org,
                invoice,
                stripeId(charge),
                "refund",
                "refunded",
                state.clock(),
              ),
            );
          if (dispute && status)
            after.push(
              applyOrganizationReversal(
                state,
                org,
                invoice,
                stripeId(dispute),
                "dispute",
                status,
                state.clock(),
              ),
            );
          return () => {
            for (const fn of after) fn();
          };
        })
        .immediate();
      cleanup();
    }
  } finally {
    release();
  }
}

export async function refreshOrganizationLocked(
  state: ServiceState,
  org: bigint,
) {
  requireLock(state, org);
  const customer = organizationCustomer(state, org);
  if (!customer) return;
  const pending = state.db
    .prepare<[bigint], Checkout>(
      "SELECT * FROM organization_checkouts WHERE organization_id=? AND state IN ('pending','payment_pending','unknown') ORDER BY updated_at_ms LIMIT 1",
    )
    .all(org);
  for (const row of pending) {
    const session = row.stripe_session_id
      ? await get(
          state,
          `checkout/sessions/${stripeId(row.stripe_session_id)}?expand[]=line_items`,
        )
      : await findCheckout(state, row, customer);
    if (session) recordOrganizationCheckout(state, row, customer, session);
  }
  const sub = state.db
    .prepare<[bigint], Subscription>(
      "SELECT * FROM organization_subscriptions WHERE organization_id=?",
    )
    .get(org);
  if (!sub) return;
  let current = await get(
    state,
    `subscriptions/${stripeId(sub.stripe_subscription_id)}`,
  );
  current = (await synchronizeSubscription(state, org, current)).current;
  if (current.latest_invoice != null)
    await applyInvoice(
      state,
      org,
      await get(state, `invoices/${stripeId(current.latest_invoice)}`),
      current,
    );
}
export async function refreshOrganizationForAccount(
  state: ServiceState,
  account: bigint,
) {
  if (!state.config.billing) return;
  const member = state.db
    .prepare<
      [bigint],
      { organization_id: bigint; checked_at_ms: bigint | null }
    >(
      "SELECT m.organization_id,s.checked_at_ms FROM organization_members m LEFT JOIN organization_subscriptions s ON s.organization_id=m.organization_id WHERE m.account_id=?",
    )
    .get(account);
  if (
    !member ||
    (member.checked_at_ms !== null &&
      state.clock() - member.checked_at_ms < 5_000n)
  )
    return;
  let release: (() => void) | undefined;
  try {
    release = acquireBilling(state, `org:${member.organization_id}`);
    state.db
      .transaction(() =>
        reserveAttempt(
          state.db,
          member.organization_id,
          "org_refresh",
          state.clock(),
          5_000n,
          1n,
        ),
      )
      .immediate();
    await billingDeadline.run(AbortSignal.timeout(5_000), () =>
      refreshOrganizationLocked(state, member.organization_id),
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.code === "rate_limited" || error.code === "payment_pending")
    )
      return;
    console.warn("organization billing refresh requires retry");
  } finally {
    release?.();
  }
}
export async function reconcileOrganizationBilling(state: ServiceState) {
  if (!state.config.billing) return;
  const orgs = state.db
    .prepare<[], { id: bigint }>(
      `SELECT o.id FROM organizations o LEFT JOIN organization_subscriptions s ON s.organization_id=o.id WHERE o.stripe_customer_id IS NOT NULL
    ORDER BY COALESCE(s.checked_at_ms,0),o.id LIMIT 100`,
    )
    .all();
  for (const org of orgs) {
    let release: (() => void) | undefined;
    try {
      release = acquireBilling(state, `org:${org.id}`);
      await refreshOrganizationLocked(state, org.id);
    } catch {
      console.warn("organization billing reconciliation requires retry");
    } finally {
      release?.();
    }
    if (state.draining) return;
  }
}
