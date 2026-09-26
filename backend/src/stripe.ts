import type { ServiceState } from "./state.js";
import { ApiError } from "./errors.js";
import {
  reserveAttempt,
  insertGrant,
  recordUsage,
  MS_PER_HOUR,
} from "./billing.js";
import {
  validatePrice,
  recoverPrice,
  type Offer,
  type Product,
} from "./catalog.js";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const billingDeadline = new AsyncLocalStorage<AbortSignal>();
function checkDeadline() {
  billingDeadline.getStore()?.throwIfAborted();
}

export function stripeId(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "id" in value
        ? value.id
        : undefined;
  if (typeof raw !== "string")
    throw new ApiError("invalid_request", "missing Stripe identity");
  if (!/^[a-zA-Z0-9_]{1,128}$/.test(raw))
    throw new ApiError("invalid_request", "invalid Stripe identity");
  return raw;
}

// Provider values are validated by each operation before they enter the ledger.
export type StripeObject = Record<string, unknown>;

export function stripeObject(value: unknown): StripeObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as StripeObject)
    : {};
}

export function stripeBilling(state: ServiceState) {
  if (!state.config.billing)
    throw new Error("Stripe billing is not configured");
  return state.config.billing;
}

async function request(
  state: ServiceState,
  path: string,
  key?: string,
  form?: URLSearchParams,
): Promise<StripeObject> {
  checkDeadline();
  if (state.billingCalls >= 8)
    throw new ApiError(
      "payment_pending",
      "billing provider busy; retry shortly",
    );
  state.billingCalls++;
  try {
    let response: Response;
    try {
      response = await fetch(
        `${state.config.stripeBaseUrl.replace(/\/$/, "")}/v1/${path}`,
        {
          method: form ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${stripeBilling(state).key}`,
            "Stripe-Version": "2025-06-30.basil",
            ...(key === undefined ? {} : { "Idempotency-Key": key }),
          },
          body: form,
          redirect: "error",
          signal: AbortSignal.any([
            AbortSignal.timeout(10_000),
            ...(billingDeadline.getStore()
              ? [billingDeadline.getStore()!]
              : []),
          ]),
        },
      );
    } catch {
      throw new ApiError("provider_unavailable", "billing service unavailable");
    }
    if (!form && !response.ok) {
      await response.body?.cancel();
      throw new ApiError("provider_unavailable", "billing lookup failed");
    }
    let value: StripeObject;
    try {
      value = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("object required");
    } catch {
      throw new ApiError("provider_unavailable", "invalid billing response");
    }
    checkDeadline();
    if (response.ok) return value;
    // Only these explicit rejections establish that creation did not happen.
    if (
      [400, 401, 402, 403, 404, 422].includes(response.status) &&
      ["invalid_request_error", "authentication_error", "card_error"].includes(
        String(stripeObject(value.error).type),
      )
    ) {
      throw new ApiError(
        "purchase_rejected",
        "billing rejected this attempt; retry the purchase",
      );
    }
    throw new ApiError(
      "provider_unavailable",
      "billing outcome unresolved; retry the same purchase",
    );
  } finally {
    state.billingCalls--;
  }
}

export function get(state: ServiceState, path: string) {
  return request(state, path);
}

export function post(
  state: ServiceState,
  path: string,
  key: string,
  form: [string, string][],
) {
  return request(state, path, key, new URLSearchParams(form));
}

export function hostedUrl(value: StripeObject, portal: boolean): string {
  if (typeof value.url !== "string")
    throw new ApiError("provider_unavailable", "missing billing URL");
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new ApiError("provider_unavailable", "invalid billing URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== (portal ? "billing.stripe.com" : "checkout.stripe.com") ||
    url.username ||
    url.password
  )
    throw new ApiError("provider_unavailable", "untrusted billing URL");
  return value.url;
}

export function acquireBilling(state: ServiceState, account: bigint) {
  if (state.billingInFlight.size >= 8 || state.billingInFlight.has(account))
    throw new ApiError(
      "payment_pending",
      "billing operation already pending; refresh shortly",
    );
  state.billingInFlight.add(account);
  return () => {
    state.billingInFlight.delete(account);
  };
}

export function reserveBilling(state: ServiceState, account: bigint) {
  state.db
    .transaction(() => {
      reserveAttempt(state.db, account, "billing", state.clock(), 60_000n, 6n);
      reserveAttempt(
        state.db,
        account,
        "billing",
        state.clock(),
        3_600_000n,
        60n,
      );
    })
    .immediate();
}

export async function checkout(
  state: ServiceState,
  account: bigint,
  body: { product: string; idempotencyKey: string },
) {
  state.requireAdmission();
  const pending = () =>
    state.db
      .prepare<[bigint, string], { request_key: string }>(
        "SELECT request_key FROM checkouts WHERE account_id=? AND product=? AND state IN ('pending','payment_pending') ORDER BY created_at_ms LIMIT 1",
      )
      .get(account, body.product)?.request_key;
  let release: () => void;
  try {
    release = acquireBilling(state, account);
  } catch (error) {
    const key = pending();
    if (key !== undefined) return { status: "payment_pending", attemptId: key };
    throw error;
  }
  try {
    const product = body.product;
    if (product !== "monthly" && product !== "pack")
      throw new ApiError("invalid_request", "unknown product");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotencyKey))
      throw new ApiError("invalid_request", "invalid purchase key");
    reserveBilling(state, account);
    let key = pending();
    if (key === undefined) {
      if (
        product === "monthly" &&
        state.db
          .prepare(
            "SELECT 1 FROM subscriptions WHERE account_id=? AND status NOT IN ('canceled','incomplete_expired') LIMIT 1",
          )
          .get(account)
      )
        throw new ApiError(
          "session_conflict",
          "manage your existing subscription in billing",
        );
      await validatePrice(state, "monthly");
      await validatePrice(state, "pack");
      if (
        state.db
          .prepare(
            "SELECT 1 FROM checkouts WHERE account_id=? AND request_key=?",
          )
          .get(account, body.idempotencyKey)
      )
        throw new ApiError(
          "result_unavailable",
          "purchase attempt finished; start a new purchase",
        );
      key = body.idempotencyKey;
      state.db
        .prepare(
          "INSERT INTO checkouts(account_id,request_key,product,state,created_at_ms,price_id,return_url) VALUES(?,?,?,'pending',?,?,?)",
        )
        .run(
          account,
          key,
          product,
          state.clock(),
          product === "monthly"
            ? stripeBilling(state).priceMonthly
            : stripeBilling(state).pricePack,
          state.config.checkoutReturnUrl,
        );
    }
    const create = async (
      path: string,
      providerKey: string,
      form: [string, string][],
    ) => {
      try {
        return await post(state, path, providerKey, form);
      } catch (error) {
        if (error instanceof ApiError && error.code === "purchase_rejected")
          state.db
            .prepare(
              "UPDATE checkouts SET state='failed' WHERE account_id=? AND request_key=?",
            )
            .run(account, key);
        throw error;
      }
    };
    let customer = state.db
      .prepare<[bigint], { stripe_customer_id: string | null }>(
        "SELECT stripe_customer_id FROM accounts WHERE id=?",
      )
      .get(account)?.stripe_customer_id;
    if (!customer) {
      customer = stripeId(
        await create("customers", `savvy-customer-${account}`, [
          ["metadata[savvy_account]", String(account)],
        ]),
      );
      state.db
        .prepare(
          "UPDATE accounts SET stripe_customer_id=? WHERE id=? AND stripe_customer_id IS NULL",
        )
        .run(customer, account);
    }
    const row = state.db
      .prepare<
        [bigint, string],
        {
          stripe_id: string | null;
          created_at_ms: bigint;
          price_id: string | null;
          return_url: string | null;
        }
      >(
        "SELECT stripe_id,created_at_ms,price_id,return_url FROM checkouts WHERE account_id=? AND request_key=?",
      )
      .get(account, key)!;
    if (row.stripe_id !== null) {
      const session = await get(
        state,
        `checkout/sessions/${stripeId(row.stripe_id)}`,
      );
      if (session.status === "open")
        return {
          url: hostedUrl(session, false),
          status: "payment_pending",
          attemptId: key,
        };
      if (session.status === "expired") {
        state.db
          .prepare(
            "UPDATE checkouts SET state='expired' WHERE account_id=? AND request_key=?",
          )
          .run(account, key);
        throw new ApiError(
          "result_unavailable",
          "checkout expired; start a new purchase",
        );
      }
      throw new ApiError(
        "payment_pending",
        "payment is reconciling; refresh your account",
      );
    }
    if (state.clock() - row.created_at_ms >= 23n * 3_600_000n)
      throw new ApiError(
        "payment_pending",
        "an earlier purchase has an unknown outcome; reconciliation must confirm it before retrying",
      );
    if (row.price_id === null)
      throw new ApiError(
        "payment_pending",
        "legacy purchase needs catalog reconciliation",
      );
    if (row.return_url === null)
      throw new ApiError(
        "payment_pending",
        "legacy purchase needs reconciliation",
      );
    state.db
      .prepare(
        "UPDATE checkouts SET search_cursor=NULL WHERE account_id=? AND request_key=?",
      )
      .run(account, key);
    const response = await create(
      "checkout/sessions",
      `savvy-checkout-${account}-${key}`,
      [
        ["customer", customer],
        ["mode", product === "monthly" ? "subscription" : "payment"],
        ["managed_payments[enabled]", "false"],
        ["line_items[0][price]", row.price_id],
        ["line_items[0][quantity]", "1"],
        ["client_reference_id", String(account)],
        ["metadata[savvy_account]", String(account)],
        ["metadata[savvy_product]", product],
        ["metadata[savvy_key]", key],
        ["success_url", row.return_url],
        ["cancel_url", row.return_url],
      ],
    );
    state.db
      .prepare(
        "UPDATE checkouts SET stripe_id=? WHERE account_id=? AND request_key=?",
      )
      .run(stripeId(response), account, key);
    return {
      url: hostedUrl(response, false),
      status: "payment_pending",
      attemptId: key,
    };
  } finally {
    release();
  }
}

export async function portal(state: ServiceState, account: bigint) {
  const release = acquireBilling(state, account);
  try {
    reserveBilling(state, account);
    const customer = state.db
      .prepare<[bigint], { stripe_customer_id: string | null }>(
        "SELECT stripe_customer_id FROM accounts WHERE id=?",
      )
      .get(account)?.stripe_customer_id;
    if (!customer)
      throw new ApiError("payment_pending", "no billing account yet");
    const response = await post(
      state,
      "billing_portal/sessions",
      `portal-${account}-${randomUUID()}`,
      [
        ["customer", customer],
        ["return_url", state.config.checkoutReturnUrl],
      ],
    );
    return { url: hostedUrl(response, true) };
  } finally {
    release();
  }
}

export function verifySignature(
  secret: string,
  header: string,
  body: Buffer,
  now: bigint,
) {
  const parts = header.split(",");
  if (
    Buffer.byteLength(header) > 2048 ||
    parts.filter((part) => part.startsWith("v1=")).length > 4
  )
    throw new ApiError("invalid_request", "oversized webhook signature");
  const raw = parts.find((part) => part.startsWith("t="))?.slice(2);
  if (!raw || !/^[+-]?\d+$/.test(raw))
    throw new ApiError("invalid_request", "invalid webhook signature");
  const timestamp = BigInt(raw);
  if (timestamp < -(1n << 63n) || timestamp >= 1n << 63n)
    throw new ApiError("invalid_request", "invalid webhook signature");
  if (now - timestamp > 300n || timestamp - now > 300n)
    throw new ApiError("invalid_request", "expired webhook signature");
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest();
  for (const part of parts) {
    if (!/^v1=[a-fA-F0-9]{64}$/.test(part)) continue;
    if (timingSafeEqual(expected, Buffer.from(part.slice(3), "hex"))) return;
  }
  throw new ApiError("invalid_request", "invalid webhook signature");
}

function field(value: unknown, ...path: (string | number)[]): unknown {
  for (const key of path)
    value =
      value !== null && typeof value === "object"
        ? Reflect.get(value, key)
        : undefined;
  return value;
}

function integer(value: unknown, message: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new ApiError("invalid_request", message);
  return BigInt(value);
}

function eventObjectId(event: StripeObject, kind: string) {
  if (kind === "invoice.upcoming") return "";
  return kind.startsWith("checkout.session.") ||
    kind.startsWith("invoice.") ||
    kind.startsWith("customer.subscription.") ||
    kind === "charge.refunded" ||
    kind.startsWith("charge.dispute.")
    ? stripeId(field(event, "data", "object", "id"))
    : "";
}

async function fetchEventObject(
  state: ServiceState,
  path: string,
  kind: string,
) {
  let object = await get(state, path);
  if (kind.startsWith("charge.dispute.")) {
    const disputed = object.status !== "won";
    object = await get(state, `charges/${stripeId(object.charge)}`);
    object.savvy_disputed = disputed;
  }
  if (kind === "charge.refunded" || kind.startsWith("charge.dispute.")) {
    const payment = stripeId(object.payment_intent);
    const known = state.db
      .prepare("SELECT 1 FROM allowance_grants WHERE origin=? AND kind='pack'")
      .get(payment);
    if (!known && object.invoice == null) {
      const payments = await get(
        state,
        `invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${payment}&limit=100`,
      );
      const invoice = field(payments, "data", 0, "invoice");
      if (typeof invoice === "string") object.invoice = invoice;
    }
  }
  return object;
}

export async function processEvent(state: ServiceState, event: StripeObject) {
  try {
    await processEventInner(state, event, true);
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_request") {
      let id: string | undefined;
      try {
        id = stripeId(event.id);
      } catch {
        /* No valid identity to record. */
      }
      if (id)
        state.db
          .prepare(
            "UPDATE billing_events SET status='rejected' WHERE stripe_event_id=?",
          )
          .run(id);
    }
    throw error;
  }
}

async function processEventInner(
  state: ServiceState,
  event: StripeObject,
  record: boolean,
  owner?: bigint,
) {
  checkDeadline();
  const eventId = stripeId(event.id);
  const kind = event.type;
  if (typeof kind !== "string")
    throw new ApiError("invalid_request", "missing event type");
  const objectId = eventObjectId(event, kind);
  const db = state.db;
  if (record) {
    if (
      db
        .prepare(
          "SELECT 1 FROM billing_events WHERE stripe_event_id=? AND status IN ('processed','ignored','rejected')",
        )
        .get(eventId)
    )
      return;
    db.prepare(
      "INSERT OR IGNORE INTO billing_events(stripe_event_id,event_type,status,related_ids,created_at_ms) VALUES(?,?,'pending',?,?)",
    ).run(eventId, kind, objectId, state.clock());
  }
  const path = !objectId
    ? ""
    : kind.startsWith("checkout.session.")
      ? `checkout/sessions/${objectId}?expand[]=line_items`
      : kind.startsWith("invoice.")
        ? `invoices/${objectId}`
        : kind.startsWith("customer.subscription.")
          ? `subscriptions/${objectId}`
          : kind === "charge.refunded"
            ? `charges/${objectId}`
            : kind.startsWith("charge.dispute.")
              ? `disputes/${objectId}`
              : "";
  if (!path) {
    if (record)
      db.prepare(
        "UPDATE billing_events SET status='processed' WHERE stripe_event_id=?",
      ).run(eventId);
    return;
  }
  let object = await fetchEventObject(state, path, kind);
  const customer = stripeId(object.customer);
  const account = db
    .prepare<[string], { id: bigint }>(
      "SELECT id FROM accounts WHERE stripe_customer_id=?",
    )
    .get(customer)?.id;
  if (account === undefined) {
    if (record)
      db.prepare(
        "UPDATE billing_events SET status='ignored' WHERE stripe_event_id=?",
      ).run(eventId);
    return;
  }
  if (owner !== undefined && owner !== account)
    throw new ApiError("invalid_request", "billing account mismatch");
  const release =
    owner === undefined ? acquireBilling(state, account) : undefined;
  try {
    if (release) {
      // The first fetch establishes ownership only; financial changes use a read under the account slot.
      object = await fetchEventObject(state, path, kind);
      if (stripeId(object.customer) !== customer)
        throw new ApiError("invalid_request", "billing account changed");
    }
    let purchase: [string, Product] | undefined;
    if (
      kind.startsWith("checkout.session.") &&
      object.payment_status === "paid" &&
      object.mode === "payment"
    )
      purchase = [
        stripeId(field(object, "line_items", "data", 0, "price")),
        "pack",
      ];
    else if (kind.startsWith("invoice.") && object.status === "paid")
      purchase = [
        stripeId(
          field(
            object,
            "lines",
            "data",
            0,
            "pricing",
            "price_details",
            "price",
          ),
        ),
        "monthly",
      ];
    else if (kind.startsWith("customer.subscription."))
      purchase = [
        stripeId(field(object, "items", "data", 0, "price")),
        "monthly",
      ];
    const offer = purchase
      ? await recoverPrice(state, purchase[0], purchase[1])
      : undefined;
    const now = state.clock();
    db.transaction(() => {
      if (
        typeof object.payment_intent === "string" &&
        typeof object.invoice === "string"
      )
        db.prepare(
          "INSERT INTO stripe_payments(payment_id,invoice_id,account_id) VALUES(?,?,?) ON CONFLICT(payment_id) DO UPDATE SET invoice_id=excluded.invoice_id WHERE account_id=excluded.account_id",
        ).run(object.payment_intent, object.invoice, account);
      if (kind.startsWith("checkout.session.")) {
        const known = db
          .prepare<
            [bigint, string, string | null],
            { product: string; request_key: string; price_id: string | null }
          >(
            "SELECT product,request_key,price_id FROM checkouts WHERE account_id=? AND (stripe_id=? OR request_key=?)",
          )
          .get(
            account,
            objectId,
            typeof field(object, "metadata", "savvy_key") === "string"
              ? (field(object, "metadata", "savvy_key") as string)
              : null,
          );
        if (!known)
          throw new ApiError("invalid_request", "unrecognized purchase");
        const { product, request_key: key } = known;
        if (object.payment_status === "paid" && product === "pack") {
          const items = field(object, "line_items", "data");
          if (
            object.mode !== "payment" ||
            field(object, "line_items", "has_more") === true ||
            !Array.isArray(items) ||
            items.length !== 1 ||
            field(items, 0, "quantity") !== 1
          )
            throw new ApiError("invalid_request", "purchase product mismatch");
          const price = stripeId(field(items, 0, "price"));
          if (known.price_id !== null && known.price_id !== price)
            throw new ApiError("invalid_request", "purchase price mismatch");
          db.prepare(
            "UPDATE checkouts SET price_id=? WHERE account_id=? AND request_key=? AND price_id IS NULL",
          ).run(price, account, key);
          const origin = stripeId(object.payment_intent);
          grantPurchase(state, account, origin, "pack", offer, now, null);
        }
        if (typeof object.subscription === "string")
          db.prepare(
            "UPDATE checkouts SET subscription_id=? WHERE account_id=? AND request_key=?",
          ).run(object.subscription, account, key);
        if (object.status === "complete" || object.status === "expired") {
          const status =
            object.payment_status !== "paid" &&
            kind === "checkout.session.async_payment_failed"
              ? "failed"
              : object.status === "complete" &&
                  (product === "monthly" || object.payment_status !== "paid")
                ? "payment_pending"
                : object.status;
          db.prepare(
            "UPDATE checkouts SET state=?,stripe_id=? WHERE account_id=? AND request_key=?",
          ).run(status, objectId, account, key);
        }
      } else if (kind.startsWith("invoice.") && object.status === "paid") {
        const lines = field(object, "lines", "data");
        if (
          !["subscription_create", "subscription_cycle"].includes(
            String(object.billing_reason),
          ) ||
          object.currency !== "usd" ||
          field(object, "lines", "has_more") === true ||
          !Array.isArray(lines) ||
          lines.length !== 1
        )
          throw new ApiError(
            "invalid_request",
            "invoice is not an eligible recurring subscription payment",
          );
        const line = lines[0];
        if (
          field(line, "quantity") !== 1 ||
          field(line, "parent", "subscription_item_details", "proration") ===
            true
        )
          throw new ApiError("invalid_request", "invoice product mismatch");
        const start =
          integer(field(line, "period", "start"), "missing paid period") *
          1000n;
        const end =
          integer(field(line, "period", "end"), "missing paid period") * 1000n;
        if (end <= start || start < -(1n << 63n) || end >= 1n << 63n)
          throw new ApiError("invalid_request", "invalid paid period");
        const subscription = stripeId(
          field(object, "parent", "subscription_details", "subscription"),
        );
        const fresh = db
          .prepare("INSERT OR IGNORE INTO subscription_periods VALUES(?,?,?,?)")
          .run(subscription, start, end, objectId).changes;
        if (fresh === 1)
          grantPurchase(state, account, objectId, "monthly", offer, start, end);
        db.prepare(
          "INSERT INTO subscriptions(account_id,stripe_subscription_id,price_id,status,paid_through_ms,updated_at_ms) VALUES(?,?,?,'active',?,?) ON CONFLICT(stripe_subscription_id) DO UPDATE SET paid_through_ms=max(COALESCE(paid_through_ms,0),excluded.paid_through_ms)",
        ).run(
          account,
          subscription,
          stripeId(field(line, "pricing", "price_details", "price")),
          end,
          now,
        );
      } else if (kind.startsWith("customer.subscription.")) {
        const price = stripeId(field(object, "items", "data", 0, "price"));
        db.prepare(
          "INSERT INTO subscriptions(account_id,stripe_subscription_id,price_id,status,cancel_at_period_end,updated_at_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(stripe_subscription_id) DO UPDATE SET status=excluded.status,cancel_at_period_end=excluded.cancel_at_period_end,updated_at_ms=excluded.updated_at_ms",
        ).run(
          account,
          objectId,
          price,
          typeof object.status === "string" ? object.status : "unknown",
          object.cancel_at_period_end === true ? 1 : 0,
          now,
        );
        if (
          object.status === "canceled" ||
          object.status === "incomplete_expired"
        )
          db.prepare(
            "UPDATE checkouts SET state='complete' WHERE account_id=? AND subscription_id=? AND product='monthly' AND state='payment_pending'",
          ).run(account, objectId);
      } else if (
        (kind === "charge.refunded" &&
          typeof object.amount_refunded === "number" &&
          Number.isSafeInteger(object.amount_refunded) &&
          object.amount_refunded > 0) ||
        kind.startsWith("charge.dispute.")
      ) {
        const origin =
          typeof object.invoice === "string"
            ? object.invoice
            : typeof object.payment_intent === "string"
              ? object.payment_intent
              : undefined;
        if (!origin)
          throw new ApiError("invalid_request", "missing refunded purchase");
        db.prepare(
          "INSERT INTO reversals(origin,account_id,refunded,disputed) VALUES(?,?,?,?) ON CONFLICT(origin) DO UPDATE SET refunded=max(refunded,excluded.refunded),disputed=CASE WHEN ? THEN excluded.disputed ELSE disputed END",
        ).run(
          origin,
          account,
          kind === "charge.refunded" ? 1 : 0,
          object.savvy_disputed === true ? 1 : 0,
          kind.startsWith("charge.dispute.") ? 1 : 0,
        );
        db.prepare(
          "UPDATE allowance_grants SET revoked=1 WHERE origin=? AND account_id=?",
        ).run(origin, account);
        recordUsage(
          db,
          account,
          null,
          null,
          null,
          "payment_reversal",
          0n,
          0n,
          `reversal:${origin}`,
          now,
        );
      }
      db.prepare(
        "UPDATE checkouts SET state='complete' WHERE product='monthly' AND state='payment_pending' AND EXISTS(SELECT 1 FROM subscription_periods p WHERE p.subscription_id=checkouts.subscription_id)",
      ).run();
      db.prepare(
        "UPDATE allowance_grants SET revoked=COALESCE((SELECT refunded OR disputed FROM reversals WHERE origin=allowance_grants.origin),revoked) WHERE origin IN (SELECT origin FROM reversals)",
      ).run();
      if (record)
        db.prepare(
          "UPDATE billing_events SET status='processed' WHERE stripe_event_id=?",
        ).run(eventId);
    }).immediate();
  } finally {
    release?.();
  }
}

function grantPurchase(
  state: ServiceState,
  account: bigint,
  origin: string,
  product: Product,
  offer: Offer | undefined,
  from: bigint,
  until: bigint | null,
) {
  if (!offer)
    throw new ApiError("invalid_request", "purchase product mismatch");
  const hours = integer(offer.hours, "invalid historical allowance"),
    briefs = integer(offer.briefs, "invalid historical allowance");
  if (hours < 0n || briefs < 0n || hours * MS_PER_HOUR >= 1n << 63n)
    throw new ApiError("invalid_request", "invalid historical allowance");
  if (
    insertGrant(
      state.db,
      account,
      origin,
      product,
      hours * MS_PER_HOUR,
      briefs,
      from,
      until,
    )
  )
    state.db
      .prepare("UPDATE allowance_grants SET policy_version=? WHERE origin=?")
      .run(offer.version, origin);
}

export async function webhook(
  state: ServiceState,
  header: string,
  body: Buffer,
) {
  state.db
    .transaction(() =>
      reserveAttempt(state.db, 0n, "webhook", state.clock(), 60_000n, 120n),
    )
    .immediate();
  verifySignature(
    stripeBilling(state).webhookSecret,
    header,
    body,
    state.clock() / 1000n,
  );
  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new ApiError("invalid_request", "invalid webhook JSON");
  }
  await processEvent(state, stripeObject(event));
  return { received: true };
}

function reconciliationEvent(
  state: ServiceState,
  type: string,
  id: string,
): StripeObject {
  return {
    id: `reconcile_${id}_${state.clock() / 60_000n}`,
    type,
    data: { object: { id } },
  };
}

function logRetry(phase: string, error: unknown) {
  console.warn(
    `billing ${phase} requires retry code=${error instanceof ApiError ? error.code : "internal"}`,
  );
}

export async function reconcile(state: ServiceState) {
  if (!state.config.billing) return;
  for (const phase of [
    reconcilePending,
    reconcileEvents,
    reconcilePurchases,
    reconcileSubscriptions,
  ]) {
    if (state.draining) return;
    try {
      await billingDeadline.run(AbortSignal.timeout(5000), () => phase(state));
    } catch (error) {
      logRetry(phase.name, error);
    }
  }
}

async function reconcilePending(state: ServiceState) {
  const rows = state.db
    .prepare<[], { stripe_event_id: string }>(
      "SELECT stripe_event_id FROM billing_events WHERE status='pending' ORDER BY checked_at_ms,id LIMIT 100",
    )
    .all();
  for (const row of rows) {
    checkDeadline();
    state.db
      .prepare(
        "UPDATE billing_events SET checked_at_ms=? WHERE stripe_event_id=?",
      )
      .run(state.clock(), row.stripe_event_id);
    try {
      await processEvent(
        state,
        await get(state, `events/${stripeId(row.stripe_event_id)}`),
      );
    } catch (error) {
      logRetry("pending event", error);
    }
  }
}

async function reconcileEvents(state: ServiceState) {
  const saved = state.db
    .prepare<[], { cursor: string | null }>(
      "SELECT cursor FROM billing_sync WHERE id=1",
    )
    .get()!.cursor;
  let cursor = saved ? `&starting_after=${stripeId(saved)}` : "";
  for (let page = 0; page < 10; page++) {
    checkDeadline();
    const events = await get(state, `events?limit=100${cursor}`);
    if (!Array.isArray(events.data))
      throw new ApiError("provider_unavailable", "invalid event list");
    let pageCursor: string | undefined;
    for (const value of events.data) {
      checkDeadline();
      let event: StripeObject, id: string;
      try {
        event = stripeObject(value);
        id = stripeId(event.id);
      } catch (error) {
        logRetry("event without usable identity", error);
        continue;
      }
      const kind = typeof event.type === "string" ? event.type : "invalid";
      let object = "",
        rejected = false;
      try {
        if (typeof event.type !== "string")
          throw new ApiError("invalid_request", "missing event type");
        object = eventObjectId(event, kind);
      } catch (error) {
        rejected = true;
        logRetry("rejected event envelope", error);
      }
      state.db
        .transaction(() => {
          state.db
            .prepare(
              "INSERT OR IGNORE INTO billing_events(stripe_event_id,event_type,status,related_ids,created_at_ms) VALUES(?,?,?,?,?)",
            )
            .run(
              id,
              kind,
              rejected ? "rejected" : "pending",
              object,
              state.clock(),
            );
          state.db
            .prepare("UPDATE billing_sync SET cursor=? WHERE id=1")
            .run(id);
        })
        .immediate();
      pageCursor = id;
      if (rejected) continue;
      try {
        await processEvent(state, event);
      } catch (error) {
        logRetry("event", error);
      }
    }
    if (events.has_more !== true) {
      state.db.prepare("UPDATE billing_sync SET cursor=NULL WHERE id=1").run();
      break;
    }
    if (!pageCursor)
      throw new ApiError(
        "provider_unavailable",
        "event page has no usable cursor",
      );
    cursor = `&starting_after=${pageCursor}`;
  }
}

export async function reconcilePurchases(state: ServiceState) {
  const purchases = state.db
    .prepare<
      [],
      {
        account_id: bigint;
        request_key: string;
        stripe_id: string | null;
        stripe_customer_id: string | null;
        search_cursor: string | null;
      }
    >(
      "SELECT c.account_id,c.request_key,c.stripe_id,a.stripe_customer_id,c.search_cursor FROM checkouts c JOIN accounts a ON a.id=c.account_id WHERE c.state IN ('pending','payment_pending') ORDER BY c.checked_at_ms,c.created_at_ms,c.request_key LIMIT 100",
    )
    .all();
  for (const row of purchases) {
    checkDeadline();
    const account = row.account_id,
      key = row.request_key;
    let release: () => void;
    try {
      release = acquireBilling(state, account);
    } catch {
      continue;
    }
    try {
      state.db
        .prepare(
          "UPDATE checkouts SET checked_at_ms=? WHERE account_id=? AND request_key=?",
        )
        .run(state.clock(), account, key);
      const customer = row.stripe_customer_id;
      if (customer === null) {
        state.db
          .prepare(
            "UPDATE checkouts SET state='failed' WHERE account_id=? AND request_key=? AND created_at_ms<=?",
          )
          .run(account, key, state.clock() - 23n * 3_600_000n);
        continue;
      }
      let known = row.stripe_id;
      if (known === null) {
        const suffix = row.search_cursor
          ? `&starting_after=${stripeId(row.search_cursor)}`
          : "";
        let list: StripeObject;
        try {
          list = await get(
            state,
            `checkout/sessions?customer=${stripeId(customer)}&limit=100${suffix}`,
          );
        } catch {
          continue;
        }
        const data = list.data;
        if (
          !Array.isArray(data) ||
          typeof list.has_more !== "boolean" ||
          (list.has_more && data.length === 0)
        )
          continue;
        try {
          for (const item of data) {
            stripeId(field(item, "id"));
            const metadata = field(item, "metadata");
            if (
              !metadata ||
              typeof metadata !== "object" ||
              Array.isArray(metadata)
            )
              throw new Error("invalid purchase metadata");
          }
        } catch {
          continue;
        }
        const found = data.find(
          (item) => field(item, "metadata", "savvy_key") === key,
        );
        known = found ? stripeId(field(found, "id")) : null;
        const next =
          list.has_more && known === null
            ? stripeId(field(data.at(-1), "id"))
            : null;
        state.db
          .prepare(
            "UPDATE checkouts SET search_cursor=? WHERE account_id=? AND request_key=?",
          )
          .run(next, account, key);
        if (known === null && !list.has_more)
          state.db
            .prepare(
              "UPDATE checkouts SET state='failed' WHERE account_id=? AND request_key=? AND stripe_id IS NULL AND created_at_ms<=?",
            )
            .run(account, key, state.clock() - 23n * 3_600_000n);
      }
      if (known === null) continue;
      state.db
        .prepare(
          "UPDATE checkouts SET stripe_id=? WHERE account_id=? AND request_key=?",
        )
        .run(known, account, key);
      let checkout: StripeObject;
      try {
        checkout = await get(state, `checkout/sessions/${stripeId(known)}`);
      } catch {
        continue;
      }
      try {
        await processEventInner(
          state,
          reconciliationEvent(state, "checkout.session.completed", known),
          false,
          account,
        );
      } catch (error) {
        logRetry("purchase", error);
      }
      if (typeof checkout.subscription === "string") {
        const subscription = stripeId(checkout.subscription);
        let current: StripeObject;
        try {
          current = await get(state, `subscriptions/${subscription}`);
        } catch {
          continue;
        }
        try {
          await processEventInner(
            state,
            reconciliationEvent(
              state,
              "customer.subscription.updated",
              subscription,
            ),
            false,
            account,
          );
        } catch (error) {
          logRetry("subscription", error);
        }
        if (typeof current.latest_invoice === "string") {
          try {
            await processEventInner(
              state,
              reconciliationEvent(
                state,
                "invoice.paid",
                stripeId(current.latest_invoice),
              ),
              false,
              account,
            );
          } catch (error) {
            logRetry("invoice", error);
          }
        }
      }
    } finally {
      release();
    }
  }
}

async function reconcileSubscriptions(state: ServiceState) {
  const subscriptions = state.db
    .prepare<[], { stripe_subscription_id: string }>(
      "SELECT stripe_subscription_id FROM subscriptions WHERE status NOT IN ('canceled','incomplete_expired') ORDER BY checked_at_ms,id LIMIT 100",
    )
    .all();
  for (const row of subscriptions) {
    checkDeadline();
    const subscription = stripeId(row.stripe_subscription_id);
    state.db
      .prepare(
        "UPDATE subscriptions SET checked_at_ms=? WHERE stripe_subscription_id=?",
      )
      .run(state.clock(), subscription);
    let current: StripeObject;
    try {
      current = await get(state, `subscriptions/${subscription}`);
    } catch {
      continue;
    }
    if (typeof current.latest_invoice === "string") {
      try {
        await processEventInner(
          state,
          reconciliationEvent(
            state,
            "invoice.paid",
            stripeId(current.latest_invoice),
          ),
          false,
        );
      } catch (error) {
        logRetry("invoice", error);
      }
    }
    try {
      await processEventInner(
        state,
        reconciliationEvent(
          state,
          "customer.subscription.updated",
          subscription,
        ),
        false,
      );
    } catch (error) {
      logRetry("subscription", error);
    }
  }
}

export async function refreshRenewal(state: ServiceState, account: bigint) {
  if (!state.config.billing) return;
  let release: () => void;
  try {
    release = acquireBilling(state, account);
  } catch {
    return;
  }
  try {
    const row = state.db
      .prepare<[bigint, bigint, bigint], { stripe_subscription_id: string }>(
        "SELECT stripe_subscription_id FROM subscriptions WHERE account_id=? AND status NOT IN ('canceled','incomplete_expired') AND COALESCE(paid_through_ms,0)<=? AND checked_at_ms<=?-5000 ORDER BY checked_at_ms LIMIT 1",
      )
      .get(account, state.clock(), state.clock());
    if (!row) return;
    state.db
      .transaction(() =>
        reserveAttempt(
          state.db,
          account,
          "renewal",
          state.clock(),
          60_000n,
          6n,
        ),
      )
      .immediate();
    state.db
      .prepare(
        "UPDATE subscriptions SET checked_at_ms=? WHERE stripe_subscription_id=?",
      )
      .run(state.clock(), row.stripe_subscription_id);
    await billingDeadline.run(AbortSignal.timeout(10_000), async () => {
      const current = await get(
        state,
        `subscriptions/${stripeId(row.stripe_subscription_id)}`,
      );
      if (typeof current.latest_invoice === "string")
        await processEventInner(
          state,
          reconciliationEvent(
            state,
            "invoice.paid",
            stripeId(current.latest_invoice),
          ),
          false,
          account,
        );
    });
  } catch {
    /* Refresh failure never invents allowance; admission reads the ledger. */
  } finally {
    release();
  }
}
