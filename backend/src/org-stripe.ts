import { refreshOrganizationLocked } from "./org-stripe-events.js";
import { randomUUID } from "node:crypto";
import type { ServiceState } from "./state.js";
import { ApiError } from "./errors.js";
import {
  teamPurchasesEnabled,
  capability,
  validTeamPortalConfiguration,
} from "./capability.js";
import { requireOwner } from "./org.js";
import { validatePrice } from "./catalog.js";
import {
  acquireBilling,
  bindCustomer,
  resolveCustomer,
  get,
  post,
  stripeId,
  stripeObject,
  hostedUrl,
  reserveBilling,
  field,
  type StripeObject,
} from "./stripe.js";

export interface Checkout {
  id: bigint;
  organization_id: bigint;
  request_key: string;
  quantity: bigint;
  price_id: string;
  return_url: string;
  stripe_idempotency_key: string;
  stripe_session_id: string | null;
  stripe_subscription_id: string | null;
  state: string;
  created_at_ms: bigint;
  search_cursor: string | null;
}
const unresolved = "('pending','payment_pending','unknown')";
function validateKey(key: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key))
    throw new ApiError("invalid_request", "invalid purchase key");
}
function validateQuantity(quantity: number) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 50)
    throw new ApiError("invalid_request", "seat quantity must be 1..50");
}
function requireAcquisition(state: ServiceState) {
  if (!teamPurchasesEnabled(state.db))
    throw new ApiError(
      "team_purchase_disabled",
      "new team purchases are currently unavailable",
    );
}
export function organizationCustomer(state: ServiceState, org: bigint) {
  const customer = state.db
    .prepare<[bigint], { stripe_customer_id: string | null }>(
      "SELECT stripe_customer_id FROM organizations WHERE id=?",
    )
    .get(org)?.stripe_customer_id;
  if (customer) {
    const owner = resolveCustomer(state.db, customer);
    if (!owner || owner.owner_kind !== "organization" || owner.owner_id !== org)
      throw new ApiError(
        "invalid_request",
        "organization customer is not bound correctly",
      );
  }
  return customer;
}
function checkoutRow(state: ServiceState, org: bigint, key: string) {
  return state.db
    .prepare<[bigint, string], Checkout>(
      "SELECT * FROM organization_checkouts WHERE organization_id=? AND request_key=?",
    )
    .get(org, key);
}

export function recordOrganizationCheckout(
  state: ServiceState,
  row: Checkout,
  customer: string,
  session: StripeObject,
) {
  const id = stripeId(session);
  if (
    !["open", "complete", "expired"].includes(String(session.status)) ||
    !["paid", "unpaid", "no_payment_required"].includes(
      String(session.payment_status),
    )
  )
    throw new ApiError(
      "provider_unavailable",
      "invalid organization checkout status",
    );
  if (
    stripeId(session.customer) !== customer ||
    session.mode !== "subscription" ||
    field(session, "metadata", "savvy_org") !==
      row.organization_id.toString() ||
    field(session, "metadata", "savvy_key") !== row.request_key ||
    (row.stripe_session_id !== null && row.stripe_session_id !== id)
  )
    throw new ApiError("invalid_request", "organization checkout mismatch");
  const items = field(session, "line_items", "data");
  if (
    !Array.isArray(items) ||
    items.length !== 1 ||
    field(session, "line_items", "has_more") === true ||
    stripeId(field(items, 0, "price")) !== row.price_id ||
    field(items, 0, "quantity") !== Number(row.quantity)
  )
    throw new ApiError(
      "invalid_request",
      "organization checkout product mismatch",
    );
  const paid =
    session.payment_status === "paid" ||
    (session.payment_status === "no_payment_required" &&
      session.amount_total === 0);
  const subscription =
    session.status === "complete" && session.subscription != null
      ? stripeId(session.subscription)
      : null;
  if (
    row.stripe_subscription_id &&
    subscription &&
    row.stripe_subscription_id !== subscription
  )
    throw new ApiError("invalid_request", "organization subscription changed");
  const status =
    session.status === "expired"
      ? "expired"
      : session.status === "complete"
        ? "payment_pending"
        : "pending";
  state.db
    .transaction(() => {
      const existing = state.db
        .prepare<
          [bigint],
          {
            stripe_subscription_id: string;
            status: string;
            paid_through_ms: bigint | null;
          }
        >(
          "SELECT stripe_subscription_id,status,paid_through_ms FROM organization_subscriptions WHERE organization_id=?",
        )
        .get(row.organization_id);
      if (
        existing &&
        subscription &&
        existing.stripe_subscription_id !== subscription &&
        (!["canceled", "incomplete_expired"].includes(existing.status) ||
          (existing.paid_through_ms ?? 0n) > state.clock())
      )
        throw new ApiError(
          "invalid_request",
          "organization already has a subscription",
        );
      state.db
        .prepare(
          "UPDATE organization_checkouts SET stripe_session_id=?,stripe_subscription_id=COALESCE(?,stripe_subscription_id),state=CASE WHEN state='complete' THEN state ELSE ? END,updated_at_ms=? WHERE id=?",
        )
        .run(id, subscription, status, state.clock(), row.id);
      if (subscription && paid)
        state.db
          .prepare(
            "INSERT INTO organization_subscriptions(organization_id,stripe_subscription_id,price_id,status,quantity_next,updated_at_ms) VALUES(?,?,?,'incomplete',?,?) ON CONFLICT(organization_id) DO UPDATE SET stripe_subscription_id=excluded.stripe_subscription_id,stripe_item_id=NULL,price_id=excluded.price_id,status='incomplete',quantity_next=excluded.quantity_next,paid_through_ms=NULL,cancel_at_period_end=0,external_change=0,checked_at_ms=0,updated_at_ms=excluded.updated_at_ms WHERE organization_subscriptions.stripe_subscription_id<>excluded.stripe_subscription_id AND organization_subscriptions.status IN ('canceled','incomplete_expired') AND COALESCE(organization_subscriptions.paid_through_ms,0)<=excluded.updated_at_ms",
          )
          .run(
            row.organization_id,
            subscription,
            row.price_id,
            row.quantity,
            state.clock(),
          );
    })
    .immediate();
  return {
    status: row.state === "complete" ? "complete" : status,
    attemptId: row.request_key,
  };
}
export async function findCheckout(
  state: ServiceState,
  row: Checkout,
  customer: string,
): Promise<StripeObject | undefined> {
  let cursor = row.search_cursor;
  for (let page = 0; page < 8; page++) {
    const query = new URLSearchParams({
      customer,
      limit: "100",
      "expand[]": "data.line_items",
    });
    if (cursor) query.set("starting_after", stripeId(cursor));
    const result = await get(state, `checkout/sessions?${query}`),
      data = result.data;
    if (!Array.isArray(data))
      throw new ApiError(
        "provider_unavailable",
        "invalid checkout reconciliation response",
      );
    for (const value of data) {
      const session = stripeObject(value);
      if (
        field(session, "metadata", "savvy_org") ===
          row.organization_id.toString() &&
        field(session, "metadata", "savvy_key") === row.request_key
      )
        return session;
    }
    if (result.has_more !== true) {
      state.db
        .prepare(
          "UPDATE organization_checkouts SET search_cursor=NULL WHERE id=?",
        )
        .run(row.id);
      return undefined;
    }
    if (!data.length)
      throw new ApiError(
        "provider_unavailable",
        "empty checkout reconciliation page",
      );
    const next = stripeId(data.at(-1));
    if (next === cursor)
      throw new ApiError(
        "provider_unavailable",
        "checkout reconciliation did not advance",
      );
    cursor = next;
    state.db
      .prepare("UPDATE organization_checkouts SET search_cursor=? WHERE id=?")
      .run(cursor, row.id);
  }
  throw new ApiError(
    "payment_pending",
    "checkout reconciliation continues on the next refresh",
  );
}

export async function organizationCheckout(
  state: ServiceState,
  actor: bigint,
  org: bigint,
  body: { quantity: number; requestKey: string },
) {
  validateQuantity(body.quantity);
  validateKey(body.requestKey);
  requireOwner(state.db, actor, org);
  const release = acquireBilling(state, `org:${org}`);
  try {
    let row = checkoutRow(state, org, body.requestKey);
    if (row && row.quantity !== BigInt(body.quantity))
      throw new ApiError(
        "checkout_mismatch",
        "this checkout key is already bound to another quantity",
      );
    if (!row) {
      state.requireAdmission();
      requireAcquisition(state);
      reserveBilling(state, actor);
      const previous = state.db
        .prepare<[bigint], { status: string; paid_through_ms: bigint | null }>(
          "SELECT status,paid_through_ms FROM organization_subscriptions WHERE organization_id=?",
        )
        .get(org);
      if (
        previous &&
        ["canceled", "incomplete_expired"].includes(previous.status) &&
        (previous.paid_through_ms ?? 0n) <= state.clock()
      )
        await refreshOrganizationLocked(state, org);
      const price = await validatePrice(state, "monthly");
      state.db
        .transaction(() => {
          requireOwner(state.db, actor, org);
          requireAcquisition(state);
          if (
            state.db
              .prepare(
                `SELECT 1 FROM organization_checkouts WHERE organization_id=? AND state IN ${unresolved}`,
              )
              .get(org)
          )
            throw new ApiError(
              "payment_pending",
              "an earlier team purchase is still reconciling",
            );
          if (
            state.db
              .prepare(
                "SELECT 1 FROM organization_subscriptions WHERE organization_id=? AND (status NOT IN ('canceled','incomplete_expired') OR COALESCE(paid_through_ms,0)>?)",
              )
              .get(org, state.clock())
          )
            throw new ApiError(
              "session_conflict",
              "manage the existing team subscription",
            );
          const now = state.clock();
          state.db
            .prepare(
              "INSERT INTO organization_checkouts(organization_id,request_key,quantity,price_id,return_url,stripe_idempotency_key,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'pending',?,?)",
            )
            .run(
              org,
              body.requestKey,
              body.quantity,
              price,
              new URL("/team?checkout=returned", state.config.issuer).href,
              `savvy-org-checkout-${org}-${body.requestKey}`,
              now,
              now,
            );
        })
        .immediate();
      row = checkoutRow(state, org, body.requestKey)!;
    }
    if (["failed", "expired"].includes(row.state))
      throw new ApiError(
        "result_unavailable",
        "this checkout attempt ended; create a new attempt",
      );
    let customer = organizationCustomer(state, org);
    if (!customer) {
      requireOwner(state.db, actor, org);
      const response = await post(
        state,
        "customers",
        `savvy-org-customer-${org}`,
        [["metadata[savvy_org]", org.toString()]],
      );
      customer = stripeId(response);
      const created = customer;
      state.db
        .transaction(() => bindCustomer(state.db, "organization", org, created))
        .immediate();
    }
    let session: StripeObject | undefined;
    if (row.stripe_session_id)
      session = await get(
        state,
        `checkout/sessions/${stripeId(row.stripe_session_id)}?expand[]=line_items`,
      );
    else if (
      row.state === "unknown" ||
      state.clock() - row.created_at_ms >= 23n * 3_600_000n
    )
      session = await findCheckout(state, row, customer);
    if (!session) {
      if (state.clock() - row.created_at_ms >= 23n * 3_600_000n)
        throw new ApiError(
          "payment_pending",
          "an old purchase outcome must be reconciled before another purchase",
        );
      requireOwner(state.db, actor, org);
      state.db
        .prepare(
          "UPDATE organization_checkouts SET state='unknown',updated_at_ms=? WHERE id=?",
        )
        .run(state.clock(), row.id);
      try {
        session = await post(
          state,
          "checkout/sessions",
          row.stripe_idempotency_key,
          [
            ["customer", customer],
            ["mode", "subscription"],
            ["managed_payments[enabled]", "false"],
            ["allow_promotion_codes", "true"],
            ["line_items[0][price]", row.price_id],
            ["line_items[0][quantity]", row.quantity.toString()],
            ["client_reference_id", `org:${org}`],
            ["metadata[savvy_org]", org.toString()],
            ["metadata[savvy_key]", row.request_key],
            ["subscription_data[metadata][savvy_org]", org.toString()],
            ["success_url", row.return_url],
            ["cancel_url", row.return_url],
            ["expand[]", "line_items"],
          ],
        );
      } catch (error) {
        if (error instanceof ApiError && error.code === "purchase_rejected")
          state.db
            .prepare(
              "UPDATE organization_checkouts SET state='failed',updated_at_ms=? WHERE id=?",
            )
            .run(state.clock(), row.id);
        throw error;
      }
    }
    const result = recordOrganizationCheckout(state, row, customer, session);
    requireOwner(state.db, actor, org);
    return {
      ...result,
      ...(session.status === "open" ? { url: hostedUrl(session, false) } : {}),
    };
  } finally {
    release();
  }
}

export async function organizationPortal(
  state: ServiceState,
  actor: bigint,
  org: bigint,
) {
  requireOwner(state.db, actor, org);
  const release = acquireBilling(state, `org:${org}`);
  try {
    reserveBilling(state, actor);
    const customer = organizationCustomer(state, org),
      configuration = capability(
        state.db,
        "organization_portal_configuration_id",
      );
    if (!customer || !configuration)
      throw new ApiError(
        "payment_pending",
        "team billing portal is not configured",
      );
    const value = await get(
      state,
      `billing_portal/configurations/${stripeId(configuration)}`,
    );
    if (!validTeamPortalConfiguration(value, configuration))
      throw new ApiError(
        "provider_unavailable",
        "team billing portal configuration is unsafe",
      );
    requireOwner(state.db, actor, org);
    const response = await post(
      state,
      "billing_portal/sessions",
      `org-portal-${org}-${randomUUID()}`,
      [
        ["customer", customer],
        ["configuration", configuration],
        ["return_url", new URL("/team", state.config.issuer).href],
      ],
    );
    requireOwner(state.db, actor, org);
    return { url: hostedUrl(response, true) };
  } finally {
    release();
  }
}

interface QuantityChange {
  stripe_subscription_id: string;
  stripe_item_id: string;
  price_id: string;
  created_at_ms: bigint;
  id: bigint;
  quantity: bigint;
  request_key: string;
  retire_seat_ids: string;
  previous_retire_seat_ids: string;
  stripe_idempotency_key: string;
  state: string;
}
function retireIds(value: string): string[] {
  const ids: unknown = JSON.parse(value);
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id))
  )
    throw new Error("Invalid persisted seat retirement plan");
  return ids;
}
export function applyRetirementPlan(
  state: ServiceState,
  org: bigint,
  ids: string[],
) {
  if (!state.db.inTransaction)
    throw new Error("Seat retirement requires a transaction");
  const set = new Set(ids);
  const seats = state.db
    .prepare<[bigint], { id: bigint }>(
      "SELECT id FROM seats WHERE organization_id=? AND status<>'retired'",
    )
    .all(org);
  if (ids.some((id) => !seats.some((s) => s.id.toString() === id)))
    throw new ApiError(
      "invalid_request",
      "retirement seat does not belong to this organization",
    );
  for (const seat of seats)
    state.db
      .prepare("UPDATE seats SET status=? WHERE id=?")
      .run(set.has(seat.id.toString()) ? "retiring" : "active", seat.id);
}
export function subscriptionDetails(
  value: StripeObject,
  expectedCustomer: string,
  expectedPrice: string,
  expectedSubscription: string,
) {
  const items = field(value, "items", "data");
  if (
    stripeId(value) !== expectedSubscription ||
    stripeId(value.customer) !== expectedCustomer ||
    !Array.isArray(items) ||
    items.length !== 1 ||
    field(value, "items", "has_more") === true ||
    stripeId(field(items, 0, "price")) !== expectedPrice
  )
    throw new ApiError(
      "invalid_request",
      "organization subscription identity mismatch",
    );
  const quantity = field(items, 0, "quantity");
  if (typeof quantity !== "number")
    throw new ApiError("invalid_request", "missing subscription seat quantity");
  validateQuantity(quantity);
  return { item: stripeId(field(items, 0, "id")), quantity };
}

export async function updateSeatQuantity(
  state: ServiceState,
  actor: bigint,
  org: bigint,
  body: { quantity: number; retireSeatIds: string[]; requestKey: string },
) {
  validateQuantity(body.quantity);
  validateKey(body.requestKey);
  requireOwner(state.db, actor, org);
  if (
    !Array.isArray(body.retireSeatIds) ||
    body.retireSeatIds.length > 50 ||
    body.retireSeatIds.some(
      (id) => typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id),
    )
  )
    throw new ApiError("invalid_request", "invalid retirement seat IDs");
  const ids = [...body.retireSeatIds].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
  );
  if (new Set(ids).size !== ids.length)
    throw new ApiError("invalid_request", "duplicate retirement seat ID");
  const encoded = JSON.stringify(ids),
    release = acquireBilling(state, `org:${org}`);
  try {
    const customer = organizationCustomer(state, org);
    const subscription = state.db
      .prepare<
        [bigint],
        {
          stripe_subscription_id: string;
          stripe_item_id: string | null;
          price_id: string;
          status: string;
        }
      >("SELECT * FROM organization_subscriptions WHERE organization_id=?")
      .get(org);
    if (
      !customer ||
      !subscription ||
      !subscription.stripe_item_id ||
      ["canceled", "incomplete_expired"].includes(subscription.status)
    )
      throw new ApiError(
        "invalid_request",
        "there is no editable team subscription",
      );
    let operation = state.db
      .prepare<[bigint, string], QuantityChange>(
        "SELECT * FROM organization_quantity_changes WHERE organization_id=? AND request_key=?",
      )
      .get(org, body.requestKey);
    if (
      operation &&
      (operation.quantity !== BigInt(body.quantity) ||
        operation.retire_seat_ids !== encoded)
    )
      throw new ApiError(
        "checkout_mismatch",
        "this change key is already bound to another retirement plan",
      );
    if (!operation) {
      state.requireAdmission();
      reserveBilling(state, actor);
      state.db
        .transaction(() => {
          requireOwner(state.db, actor, org);
          if (
            state.db
              .prepare(
                "SELECT 1 FROM organization_quantity_changes WHERE organization_id=? AND state IN ('pending','unknown')",
              )
              .get(org)
          )
            throw new ApiError(
              "payment_pending",
              "a quantity change is still reconciling",
            );
          const seats = state.db
            .prepare<
              [bigint],
              { id: bigint; status: string; occupied: bigint }
            >(
              "SELECT s.id,s.status,EXISTS(SELECT 1 FROM seat_assignments a WHERE a.seat_id=s.id AND a.ended_at_ms IS NULL) AS occupied FROM seats s WHERE s.organization_id=? AND s.status<>'retired'",
            )
            .all(org);
          if (
            ids.length !== Math.max(0, seats.length - body.quantity) ||
            ids.some(
              (id) => !seats.some((s) => s.id.toString() === id && !s.occupied),
            )
          )
            throw new ApiError(
              "invalid_request",
              "choose exactly the vacant seats to retire for the next paid renewal",
            );
          const previous = seats
            .filter((s) => s.status === "retiring")
            .map((s) => s.id.toString());
          state.db
            .prepare(
              "INSERT INTO organization_quantity_changes(organization_id,request_key,quantity,retire_seat_ids,previous_retire_seat_ids,stripe_idempotency_key,stripe_subscription_id,stripe_item_id,price_id,state,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,'pending',?)",
            )
            .run(
              org,
              body.requestKey,
              body.quantity,
              encoded,
              JSON.stringify(previous),
              `savvy-org-quantity-${org}-${body.requestKey}`,
              subscription.stripe_subscription_id,
              subscription.stripe_item_id,
              subscription.price_id,
              state.clock(),
            );
          // Reserve both the prior and proposed retiring slots until Stripe confirms.
          applyRetirementPlan(state, org, [...new Set([...previous, ...ids])]);
        })
        .immediate();
      operation = state.db
        .prepare<[bigint, string], QuantityChange>(
          "SELECT * FROM organization_quantity_changes WHERE organization_id=? AND request_key=?",
        )
        .get(org, body.requestKey)!;
    }
    if (
      operation.stripe_subscription_id !==
        subscription.stripe_subscription_id ||
      operation.stripe_item_id !== subscription.stripe_item_id ||
      operation.price_id !== subscription.price_id
    )
      throw new ApiError(
        "payment_pending",
        "this quantity change belongs to the previous subscription and needs reconciliation",
      );
    if (operation.state === "failed")
      throw new ApiError(
        "result_unavailable",
        "this quantity change was rejected; create a new attempt",
      );
    if (operation.state !== "applied") {
      requireOwner(state.db, actor, org);
      let canonical = await get(
        state,
        `subscriptions/${stripeId(subscription.stripe_subscription_id)}`,
      );
      let details = subscriptionDetails(
        canonical,
        customer,
        subscription.price_id,
        subscription.stripe_subscription_id,
      );
      if (details.item !== subscription.stripe_item_id)
        throw new ApiError(
          "invalid_request",
          "organization subscription item changed",
        );
      if (details.quantity !== Number(operation.quantity)) {
        if (state.clock() - operation.created_at_ms >= 23n * 3_600_000n)
          throw new ApiError(
            "payment_pending",
            "the old quantity-change outcome must be reconciled before another update",
          );
        state.db
          .prepare(
            "UPDATE organization_quantity_changes SET state='unknown' WHERE id=?",
          )
          .run(operation.id);
        let response: StripeObject;
        try {
          requireOwner(state.db, actor, org);
          response = await post(
            state,
            `subscriptions/${stripeId(subscription.stripe_subscription_id)}`,
            operation.stripe_idempotency_key,
            [
              ["items[0][id]", subscription.stripe_item_id],
              ["items[0][quantity]", operation.quantity.toString()],
              ["proration_behavior", "none"],
            ],
          );
        } catch (error) {
          if (error instanceof ApiError && error.code === "purchase_rejected")
            state.db
              .transaction(() => {
                applyRetirementPlan(
                  state,
                  org,
                  retireIds(operation!.previous_retire_seat_ids),
                );
                state.db
                  .prepare(
                    "UPDATE organization_quantity_changes SET state='failed' WHERE id=?",
                  )
                  .run(operation!.id);
              })
              .immediate();
          throw error;
        }
        subscriptionDetails(
          response,
          customer,
          subscription.price_id,
          subscription.stripe_subscription_id,
        );
        canonical = await get(
          state,
          `subscriptions/${stripeId(subscription.stripe_subscription_id)}`,
        );
        details = subscriptionDetails(
          canonical,
          customer,
          subscription.price_id,
          subscription.stripe_subscription_id,
        );
      }
      if (
        details.item !== subscription.stripe_item_id ||
        details.quantity !== Number(operation.quantity)
      )
        throw new ApiError(
          "payment_pending",
          "the quantity change has not been confirmed yet",
        );
      state.db
        .transaction(() => {
          applyRetirementPlan(
            state,
            org,
            retireIds(operation!.retire_seat_ids),
          );
          state.db
            .prepare(
              "UPDATE organization_subscriptions SET quantity_next=?,external_change=0,updated_at_ms=? WHERE organization_id=?",
            )
            .run(operation!.quantity, state.clock(), org);
          state.db
            .prepare(
              "UPDATE organization_quantity_changes SET state='applied' WHERE id=?",
            )
            .run(operation!.id);
        })
        .immediate();
    }
    requireOwner(state.db, actor, org);
    return {
      quantity: body.quantity,
      status: "scheduled",
      effective: "next_paid_renewal",
    };
  } finally {
    release();
  }
}
