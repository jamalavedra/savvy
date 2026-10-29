import { setCapability } from "./capability.js";
import { createOrganization, assignSeat } from "./org.js";
import { organizationCheckout } from "./org-stripe.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { openServiceDatabase } from "./db.js";
import { configuration } from "./config.js";
import { ServiceState } from "./state.js";
import { managedRequest } from "./api.js";
import { CATALOG, recoverPrice, historical } from "./catalog.js";
import { balance, accountSummary, insertGrant } from "./billing.js";
import {
  acquireBilling,
  processEvent,
  reconcilePurchases,
  refreshRenewal,
  reconcile,
  type StripeObject,
} from "./stripe.js";

const event = (id: string, type: string, object: string) => ({
  id,
  type,
  data: { object: { id: object } },
});
const pack = (key: string, payment: string) => ({
  customer: "cus_test",
  metadata: { savvy_key: key },
  payment_status: "paid",
  status: "complete",
  mode: "payment",
  payment_intent: payment,
  line_items: { data: [{ price: "price_pack", quantity: 1 }] },
});
const invoice = (subscription: string, start = 1000, end = 2000) => ({
  customer: "cus_test",
  status: "paid",
  billing_reason: "subscription_cycle",
  currency: "usd",
  lines: {
    data: [
      {
        pricing: { price_details: { price: "price_monthly" } },
        quantity: 1,
        period: { start, end },
      },
    ],
  },
  parent: { subscription_details: { subscription } },
});

const price = (product: "monthly" | "pack") => ({
  id: `price_${product}`,
  active: true,
  currency: "usd",
  unit_amount: CATALOG[product].amountCents,
  billing_scheme: "per_unit",
  transform_quantity: null,
  type: product === "monthly" ? "recurring" : "one_time",
  recurring:
    product === "monthly"
      ? { interval: "month", interval_count: 1, usage_type: "licensed" }
      : null,
  metadata: { savvy_catalog_version: CATALOG[product].version },
});

test("malformed event envelopes cannot starve an older refund across pages", async (t) => {
  const h = await fixture(t);
  h.db
    .transaction(() =>
      insertGrant(
        h.db,
        1n,
        "pi_refund",
        "pack",
        10000n,
        1n,
        h.state.clock(),
        null,
      ),
    )
    .immediate();
  h.objects.set("/v1/events?limit=100", {
    data: [
      event("evt_new", "unhandled.event", "unused"),
      {},
      { id: "evt_bad_type" },
      { id: "evt_bad_object", type: "invoice.paid" },
    ],
    has_more: true,
  });
  h.objects.set("/v1/events?limit=100&starting_after=evt_bad_object", {
    data: [event("evt_refund", "charge.refunded", "ch_refund")],
    has_more: false,
  });
  h.objects.set("/v1/charges/ch_refund", {
    customer: "cus_test",
    payment_intent: "pi_refund",
    amount_refunded: 1,
  });
  for (let replay = 0; replay < 2; replay++) {
    await reconcile(h.state);
    assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsAvailable, 0n);
    assert.deepEqual(
      h.db
        .prepare(
          "SELECT stripe_event_id,status FROM billing_events ORDER BY stripe_event_id",
        )
        .all(),
      [
        { stripe_event_id: "evt_bad_object", status: "rejected" },
        { stripe_event_id: "evt_bad_type", status: "rejected" },
        { stripe_event_id: "evt_new", status: "processed" },
        { stripe_event_id: "evt_refund", status: "processed" },
      ],
    );
    assert.deepEqual(h.db.prepare("SELECT cursor FROM billing_sync").get(), {
      cursor: null,
    });
  }
});

async function fixture(t: TestContext) {
  const objects = new Map<string, StripeObject>();
  for (const product of ["monthly", "pack"] as const)
    objects.set(`/v1/prices/price_${product}`, price(product));
  const calls: string[] = [];
  const posts: { path: string; key: string; form: URLSearchParams }[] = [];
  let now = 1_000_000n;
  let postHandler = async (
    path: string,
  ): Promise<{ status: number; body: StripeObject }> => ({
    status: 200,
    body: objects.get(`POST ${path}`) ?? {},
  });
  let fetchObject = async (
    path: string,
    query: string,
  ): Promise<StripeObject | undefined> =>
    objects.get(path + query) ?? objects.get(path);
  const supplier = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost"),
      path = url.pathname;
    calls.push(path + url.search);
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw),
        key = String(req.headers["idempotency-key"]);
      posts.push({ path, form, key });
      const response = await postHandler(path);
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(JSON.stringify(response.body));
      return;
    }
    const object = await fetchObject(path, url.search);
    res.writeHead(object ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(object ?? {}));
  });
  supplier.listen(0, "127.0.0.1");
  await once(supplier, "listening");
  const address = supplier.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const db = openServiceDatabase(":memory:");
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,stripe_customer_id,created_at_ms) VALUES(1,'issuer','subject','cus_test',0),(2,'issuer','other','cus_other',0)",
  ).run();
  db.prepare(
    "INSERT INTO stripe_customers(stripe_customer_id,owner_kind,owner_id) SELECT stripe_customer_id,'account',id FROM accounts WHERE stripe_customer_id IS NOT NULL",
  ).run();
  for (const product of ["pack", "monthly"] as const)
    db.prepare("INSERT INTO catalog_prices VALUES(?,?,?)").run(
      `price_${product}`,
      product,
      JSON.stringify(CATALOG[product]),
    );
  const state = new ServiceState(
    configuration({
      BETTER_AUTH_URL: base,
      SAVVY_STRIPE_BASE_URL: base,
      SAVVY_STRIPE_SECRET_KEY: "synthetic",
      SAVVY_STRIPE_WEBHOOK_SECRET: "synthetic",
      SAVVY_STRIPE_PRICE_PACK: "price_pack",
      SAVVY_STRIPE_PRICE_MONTHLY: "price_monthly",
      SAVVY_ANTHROPIC_API_KEY: "synthetic",
      SAVVY_DEEPGRAM_API_KEY: "synthetic",
    }),
    db,
    () => now,
    async (headers) => {
      assert.equal(
        headers.authorization,
        "Bearer test",
        "Webhooks must not require bearer tokens",
      );
      return {
        accountId: 1n,
        subject: "subject",
        expiresAtMs: now + 60_000n,
        displayIdentity: {
          issuer: "issuer",
          subject: "subject",
          name: null,
          email: null,
          emailVerified: false,
        },
      };
    },
  );
  const server = createServer((req, res) => {
    void managedRequest(state, req, res, new URL(req.url!, base).pathname);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiAddress = server.address();
  assert.ok(apiAddress && typeof apiAddress !== "string");
  const api = `http://127.0.0.1:${apiAddress.port}`;
  t.after(async () => {
    for (const listener of [server, supplier]) {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    db.close();
  });
  const deliver = async (payload: StripeObject, valid = true) => {
    const raw = JSON.stringify(payload);
    const signature = createHmac("sha256", valid ? "synthetic" : "wrong")
      .update(`${now / 1000n}.`)
      .update(raw)
      .digest("hex");
    const response = await fetch(`${api}/v1/billing/webhook`, {
      method: "POST",
      headers: { "stripe-signature": `t=${now / 1000n},v1=${signature}` },
      body: raw,
    });
    return { status: response.status, body: await response.json() };
  };
  const purchase = (key: string) =>
    db
      .prepare(
        "INSERT INTO checkouts(account_id,request_key,product,state,created_at_ms,price_id,return_url) VALUES(1,?,'pack','pending',0,'price_pack','https://return.test')",
      )
      .run(key);
  return {
    state,
    db,
    objects,
    calls,
    deliver,
    purchase,
    base: api,
    posts,
    advance(ms: bigint) {
      now += ms;
    },
    async post(path: string, body: unknown) {
      const response = await fetch(api + path, {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    setPost(fn: typeof postHandler) {
      postHandler = fn;
    },
    setFetch(fn: typeof fetchObject) {
      fetchObject = fn;
    },
  };
}

test("signed HTTP webhooks replay once, isolate purchase refunds and retain monthly reversal tombstones", async (t) => {
  const h = await fixture(t);
  h.purchase("one");
  h.objects.set("/v1/checkout/sessions/cs_one", pack("one", "pi_one"));
  const paid = event("evt_one", "checkout.session.completed", "cs_one");
  const release = acquireBilling(h.state, "account:1");
  assert.equal((await h.deliver(paid)).status, 402);
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsAvailable, 0n);
  release();
  assert.equal((await h.deliver(paid, false)).status, 400);
  assert.equal((await h.deliver(paid)).status, 200);
  const calls = h.calls.length;
  assert.equal((await h.deliver(paid)).status, 200);
  assert.equal(h.calls.length, calls);
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    10_800_000n,
  );
  assert.equal(balance(h.db, 2n, h.state.clock()).meetingMsAvailable, 0n);
  h.objects.set("/v1/charges/ch_month", {
    customer: "cus_test",
    payment_intent: "pi_month",
    amount_refunded: 7900,
  });
  h.objects.set("/v1/invoice_payments", {
    data: [{ invoice: "in_month" }],
    has_more: false,
  });
  assert.equal(
    (await h.deliver(event("evt_refund", "charge.refunded", "ch_month")))
      .status,
    200,
  );
  h.objects.set("/v1/invoices/in_month", invoice("sub_one"));
  assert.equal(
    (await h.deliver(event("evt_month", "invoice.paid", "in_month"))).status,
    200,
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    10_800_000n,
  );
  h.objects.set("/v1/invoices/in_duplicate", invoice("sub_one"));
  assert.equal(
    (await h.deliver(event("evt_duplicate", "invoice.paid", "in_duplicate")))
      .status,
    200,
  );
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM allowance_grants WHERE kind='monthly'",
      )
      .get(),
    { n: 1n },
  );
  h.objects.set("/v1/charges/ch_pack", {
    customer: "cus_test",
    payment_intent: "pi_one",
    amount_refunded: 0,
  });
  h.objects.set("/v1/disputes/dp_pack", {
    status: "needs_response",
    charge: "ch_pack",
  });
  assert.equal(
    (
      await h.deliver(
        event("evt_pack_dispute", "charge.dispute.created", "dp_pack"),
      )
    ).status,
    200,
  );
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsAvailable, 0n);
  h.objects.set("/v1/disputes/dp_pack", { status: "won", charge: "ch_pack" });
  assert.equal(
    (await h.deliver(event("evt_pack_won", "charge.dispute.closed", "dp_pack")))
      .status,
    200,
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    10_800_000n,
    "winning the pack dispute must not reactivate the refunded monthly grant",
  );
  h.objects.set("/v1/charges/ch_pack", {
    customer: "cus_test",
    payment_intent: "pi_one",
    amount_refunded: 1,
  });
  assert.equal(
    (await h.deliver(event("evt_pack_refund", "charge.refunded", "ch_pack")))
      .status,
    200,
  );
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsAvailable, 0n);
  h.objects.set("/v1/disputes/dp_pack", { status: "won", charge: "ch_pack" });
  assert.equal(
    (
      await h.deliver(
        event("evt_dispute_won", "charge.dispute.closed", "dp_pack"),
      )
    ).status,
    200,
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    0n,
    "winning a dispute must not clear a refund",
  );
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM usage_events WHERE kind='payment_reversal'",
      )
      .get(),
    { n: 2n },
    "dispute and refund of the same purchase share its reversal usage row",
  );
});

test("invalid purchased lines roll back grants and permanent rejection; supplier failure stays pending", async (t) => {
  const h = await fixture(t);
  h.purchase("bad");
  const bad = pack("bad", "pi_bad");
  bad.line_items.data[0].quantity = 2;
  h.objects.set("/v1/checkout/sessions/cs_bad", bad);
  const payload = event("evt_bad", "checkout.session.completed", "cs_bad");
  assert.equal((await h.deliver(payload)).status, 400);
  assert.deepEqual(
    h.db.prepare("SELECT COUNT(*) AS n FROM allowance_grants").get(),
    { n: 0n },
  );
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT status FROM billing_events WHERE stripe_event_id='evt_bad'",
      )
      .get(),
    { status: "rejected" },
  );
  const calls = h.calls.length;
  assert.equal((await h.deliver(payload)).status, 200);
  assert.equal(h.calls.length, calls);
  assert.equal(
    (await h.deliver(event("evt_outage", "invoice.paid", "in_outage"))).status,
    503,
  );
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT status FROM billing_events WHERE stripe_event_id='evt_outage'",
      )
      .get(),
    { status: "pending" },
  );
  assert.equal(h.state.billingInFlight.size, 0);
});

test("a delayed ownership fetch refetches after newer subscription state and rejects changed ownership", async (t) => {
  const h = await fixture(t);
  const active = {
    customer: "cus_test",
    status: "active",
    items: { data: [{ price: "price_monthly" }] },
  };
  const canceled = { ...active, status: "canceled" };
  let unblock!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let reads = 0;
  h.setFetch(async () => {
    if (++reads === 1) {
      started();
      await blocked;
      return active;
    }
    return canceled;
  });
  const older = processEvent(
    h.state,
    event("evt_old", "customer.subscription.updated", "sub_one"),
  );
  await began;
  await processEvent(
    h.state,
    event("evt_new", "customer.subscription.updated", "sub_one"),
  );
  unblock();
  await older;
  assert.equal(reads, 4);
  assert.deepEqual(h.db.prepare("SELECT status FROM subscriptions").get(), {
    status: "canceled",
  });
  let changed = false;
  h.setFetch(async () => {
    const value = { ...active, customer: changed ? "cus_other" : "cus_test" };
    changed = true;
    return value;
  });
  await assert.rejects(
    processEvent(
      h.state,
      event("evt_changed", "customer.subscription.updated", "sub_one"),
    ),
    { code: "invalid_request" },
  );
  assert.deepEqual(h.db.prepare("SELECT status FROM subscriptions").get(), {
    status: "canceled",
  });
  assert.equal(h.state.billingInFlight.size, 0);
});

test("reconciliation preserves uncertain purchases through malformed pages, recovers late fulfillment and never records synthetic events", async (t) => {
  const h = await fixture(t);
  h.purchase("unknown");
  h.db.prepare("UPDATE checkouts SET created_at_ms=-90000000").run();
  const pending = () =>
    h.db.prepare("SELECT state,search_cursor FROM checkouts").get();
  for (const list of [
    { data: [] },
    { data: [], has_more: true },
    { data: [{ id: "cs_bad" }], has_more: false },
    { data: [{ id: "../bad", metadata: {} }], has_more: false },
  ]) {
    h.objects.set("/v1/checkout/sessions", list);
    await reconcilePurchases(h.state);
    assert.deepEqual(pending(), { state: "pending", search_cursor: null });
  }
  h.objects.delete("/v1/checkout/sessions");
  await reconcilePurchases(h.state);
  assert.deepEqual(pending(), { state: "pending", search_cursor: null });
  h.objects.set("/v1/checkout/sessions", {
    data: [{ id: "cs_other", metadata: { savvy_key: "other" } }],
    has_more: true,
  });
  await reconcilePurchases(h.state);
  assert.deepEqual(pending(), { state: "pending", search_cursor: "cs_other" });
  h.objects.set("/v1/checkout/sessions", {
    data: [{ id: "cs_found", metadata: { savvy_key: "unknown" } }],
    has_more: false,
  });
  h.objects.set("/v1/checkout/sessions/cs_found", pack("unknown", "pi_found"));
  await reconcilePurchases(h.state);
  assert.deepEqual(pending(), { state: "complete", search_cursor: null });
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    10_800_000n,
  );
  assert.deepEqual(
    h.db.prepare("SELECT COUNT(*) AS n FROM billing_events").get(),
    { n: 0n },
  );
  h.purchase("absent");
  h.db
    .prepare(
      "UPDATE checkouts SET created_at_ms=-90000000 WHERE request_key='absent'",
    )
    .run();
  h.objects.set("/v1/checkout/sessions", { data: [], has_more: false });
  await reconcilePurchases(h.state);
  assert.deepEqual(
    h.db
      .prepare("SELECT state FROM checkouts WHERE request_key='absent'")
      .get(),
    { state: "failed" },
  );
  assert.equal(h.state.billingInFlight.size, 0);
});

test("expired paid-through renewal uses the same account slot and a failed old event cannot starve recovery", async (t) => {
  const h = await fixture(t);
  h.db
    .prepare(
      "INSERT INTO subscriptions(account_id,stripe_subscription_id,price_id,status,paid_through_ms,updated_at_ms) VALUES(1,'sub_one','price_monthly','active',1,0)",
    )
    .run();
  h.objects.set("/v1/subscriptions/sub_one", {
    customer: "cus_test",
    status: "active",
    latest_invoice: "in_new",
    items: { data: [{ price: "price_monthly" }] },
  });
  h.objects.set("/v1/invoices/in_new", invoice("sub_one"));
  await refreshRenewal(h.state, 1n);
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    36_000_000n,
  );
  const calls = h.calls.length;
  await refreshRenewal(h.state, 1n);
  assert.equal(h.calls.length, calls);
  assert.deepEqual(
    h.db.prepare("SELECT COUNT(*) AS n FROM billing_events").get(),
    { n: 0n },
  );
  h.db
    .prepare(
      "INSERT INTO billing_events(stripe_event_id,event_type,status,created_at_ms) VALUES('evt_old','invoice.paid','pending',0)",
    )
    .run();
  h.objects.set("/v1/events", { data: [], has_more: false });
  h.purchase("recover");
  h.objects.set("/v1/checkout/sessions", {
    data: [{ id: "cs_recover", metadata: { savvy_key: "recover" } }],
    has_more: false,
  });
  h.objects.set(
    "/v1/checkout/sessions/cs_recover",
    pack("recover", "pi_recover"),
  );
  await reconcile(h.state);
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    46_800_000n,
  );
  assert.deepEqual(
    h.db.prepare("SELECT COUNT(*) AS n FROM billing_events").get(),
    { n: 1n },
  );
  assert.equal(h.state.billingInFlight.size, 0);
});

test(
  "a stalled reconciliation phase cancels its provider request and releases capacity for purchase recovery",
  { timeout: 15000 },
  async (t) => {
    const h = await fixture(t);
    h.db
      .prepare(
        "INSERT INTO billing_events(stripe_event_id,event_type,status,created_at_ms) VALUES('evt_stalled','invoice.paid','pending',0)",
      )
      .run();
    h.purchase("after_timeout");
    let unblock!: () => void;
    const stalled = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    h.setFetch(async (path) => {
      if (path === "/v1/events/evt_stalled") {
        await stalled;
        return event("evt_stalled", "invoice.paid", "in_missing");
      }
      if (path === "/v1/events") return { data: [], has_more: false };
      if (path === "/v1/checkout/sessions")
        return {
          data: [
            { id: "cs_timeout", metadata: { savvy_key: "after_timeout" } },
          ],
          has_more: false,
        };
      if (path === "/v1/checkout/sessions/cs_timeout")
        return pack("after_timeout", "pi_timeout");
      return undefined;
    });
    try {
      await reconcile(h.state);
      assert.equal(
        balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
        10_800_000n,
      );
      assert.equal(h.state.billingCalls, 0);
      assert.equal(h.state.billingInFlight.size, 0);
      assert.deepEqual(
        h.db
          .prepare(
            "SELECT status FROM billing_events WHERE stripe_event_id='evt_stalled'",
          )
          .get(),
        { status: "pending" },
      );
    } finally {
      unblock();
    }
  },
);

test("delayed pack payment stays pending until authoritative paid state, including reordered failure and replay", async (t) => {
  const h = await fixture(t);
  h.purchase("delayed");
  const value = pack("delayed", "pi_delayed");
  value.payment_status = "unpaid";
  h.objects.set("/v1/checkout/sessions/cs_delayed", value);
  assert.equal(
    (
      await h.deliver(
        event("evt_unpaid", "checkout.session.completed", "cs_delayed"),
      )
    ).status,
    200,
  );
  assert.equal(accountSummary(h.db, 1n, h.state.clock()).paymentPending, true);
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsAvailable, 0n);
  assert.equal(
    (
      await h.deliver(
        event(
          "evt_failed",
          "checkout.session.async_payment_failed",
          "cs_delayed",
        ),
      )
    ).status,
    200,
  );
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsAvailable, 0n);
  value.payment_status = "paid";
  for (const id of ["evt_paid", "evt_paid", "evt_reordered"])
    assert.equal(
      (
        await h.deliver(
          event(id, "checkout.session.async_payment_succeeded", "cs_delayed"),
        )
      ).status,
      200,
    );
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    10_800_000n,
  );
  assert.equal(accountSummary(h.db, 1n, h.state.clock()).paymentPending, false);
  assert.deepEqual(
    h.db.prepare("SELECT count(*) AS n FROM allowance_grants").get(),
    { n: 1n },
  );
});

test("invoice replay grants once, a pack refund preserves monthly time, and a won dispute restores only undisputed unrefunded grants", async (t) => {
  const h = await fixture(t);
  const checkout = {
    id: "cs_one",
    status: "open",
    url: "https://checkout.stripe.com/c/pay/test#fragment",
  };
  h.objects.set("POST /v1/checkout/sessions", checkout);
  const buy = { product: "pack", idempotencyKey: "one" };
  assert.equal((await h.post("/v1/billing/checkout", buy)).status, 200);
  h.objects.set("/v1/checkout/sessions/cs_one", checkout);
  assert.equal((await h.post("/v1/billing/checkout", buy)).status, 200);
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsAvailable, 0n);
  h.objects.set("/v1/checkout/sessions/cs_one", pack("one", "pi_one"));
  await h.deliver(event("evt_one", "checkout.session.completed", "cs_one"));
  h.objects.set("POST /v1/billing_portal/sessions", {
    url: "https://billing.stripe.com/p/session/test",
  });
  assert.equal((await h.post("/v1/billing/portal", {})).status, 200);
  const start = Number(h.state.clock() / 1000n);
  h.objects.set(
    "/v1/invoices/in_one",
    invoice("sub_one", start, start + 2_592_000),
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await h.deliver(event("evt_month", "invoice.paid", "in_one"))).status,
      200,
    );
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    46_800_000n,
  );
  h.objects.set("/v1/charges/ch_one", {
    customer: "cus_test",
    payment_intent: "pi_one",
    amount_refunded: 0,
  });
  h.objects.set("/v1/disputes/dp_one", {
    status: "needs_response",
    charge: "ch_one",
  });
  assert.equal(
    (await h.deliver(event("evt_dispute", "charge.dispute.created", "dp_one")))
      .status,
    200,
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    36_000_000n,
  );
  h.objects.set("/v1/disputes/dp_one", { status: "won", charge: "ch_one" });
  assert.equal(
    (await h.deliver(event("evt_won", "charge.dispute.closed", "dp_one")))
      .status,
    200,
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    46_800_000n,
  );
  h.objects.set("/v1/charges/ch_one", {
    customer: "cus_test",
    payment_intent: "pi_one",
    amount_refunded: 2900,
  });
  assert.equal(
    (await h.deliver(event("evt_refund", "charge.refunded", "ch_one"))).status,
    200,
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    36_000_000n,
  );
  h.advance(2_592_000_000n);
  assert.equal(
    (await h.deliver(event("evt_month", "invoice.paid", "in_one"))).status,
    200,
  );
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsAvailable, 0n);
});

test("missed renewal and initial subscription checkout recover without synthetic event growth, and cancellation leaves packs", async (t) => {
  const h = await fixture(t);
  h.purchase("initial");
  h.db
    .prepare("UPDATE checkouts SET product='monthly',price_id='price_monthly'")
    .run();
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
  h.objects.set("/v1/checkout/sessions", {
    data: [{ id: "cs_initial", metadata: { savvy_key: "initial" } }],
    has_more: false,
  });
  h.objects.set("/v1/checkout/sessions/cs_initial", {
    customer: "cus_test",
    metadata: { savvy_key: "initial" },
    status: "complete",
    mode: "subscription",
    payment_status: "paid",
    subscription: "sub_one",
  });
  h.objects.set("/v1/subscriptions/sub_one", {
    customer: "cus_test",
    status: "active",
    cancel_at_period_end: true,
    latest_invoice: "in_one",
    items: { data: [{ price: "price_monthly" }] },
  });
  h.objects.set(
    "/v1/invoices/in_one",
    invoice("sub_one", 1000, 1000 + 2_592_000),
  );
  h.objects.set("/v1/events", {
    data: [event("evt_missed", "invoice.paid", "in_one")],
    has_more: false,
  });
  h.db
    .prepare(
      "INSERT INTO billing_events(stripe_event_id,event_type,status,created_at_ms) VALUES('evt_missing','invoice.paid','pending',0)",
    )
    .run();
  await reconcile(h.state);
  assert.deepEqual(h.db.prepare("SELECT state FROM checkouts").get(), {
    state: "complete",
  });
  const before = h.db.prepare("SELECT count(*) AS n FROM billing_events").get();
  for (let i = 0; i < 24; i++) {
    h.advance(3_600_000n);
    await reconcile(h.state);
  }
  assert.deepEqual(
    h.db.prepare("SELECT count(*) AS n FROM billing_events").get(),
    before,
  );
  const summary = accountSummary(h.db, 1n, h.state.clock());
  assert.equal(summary.meetingMsAvailable, 46_800_000n);
  assert.equal(summary.subscription?.cancelAtPeriodEnd, true);
  h.advance(2_592_000_000n);
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    10_800_000n,
  );
});

test("unknown initial checkout reconciles a subscription-create invoice without event delivery", async (t) => {
  const h = await fixture(t);
  h.purchase("lost_initial");
  h.db
    .prepare("UPDATE checkouts SET product='monthly',price_id='price_monthly'")
    .run();
  assert.deepEqual(
    h.db.prepare("SELECT stripe_id,state FROM checkouts").get(),
    {
      stripe_id: null,
      state: "pending",
    },
  );
  const checkout = {
    id: "cs_recovered",
    customer: "cus_test",
    status: "complete",
    mode: "subscription",
    payment_status: "paid",
    subscription: "sub_recovered",
    metadata: { savvy_key: "lost_initial", savvy_product: "monthly" },
  };
  h.objects.set("/v1/events", { data: [], has_more: false });
  h.objects.set("/v1/checkout/sessions", { data: [checkout], has_more: false });
  h.objects.set("/v1/checkout/sessions/cs_recovered", checkout);
  h.objects.set("/v1/subscriptions/sub_recovered", {
    id: "sub_recovered",
    customer: "cus_test",
    status: "active",
    latest_invoice: "in_recovered",
    items: { data: [{ price: "price_monthly" }] },
  });
  h.objects.set("/v1/invoices/in_recovered", {
    ...invoice("sub_recovered", 1000, 1000 + 2_592_000),
    billing_reason: "subscription_create",
  });
  await reconcile(h.state);
  await reconcile(h.state);
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    36_000_000n,
  );
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 20n);
  assert.deepEqual(
    h.db.prepare("SELECT stripe_id,state FROM checkouts").get(),
    {
      stripe_id: "cs_recovered",
      state: "complete",
    },
  );
  assert.deepEqual(
    h.db.prepare("SELECT count(*) AS n FROM allowance_grants").get(),
    { n: 1n },
  );
});

test("session admission refreshes an expired subscription before checking allowance", async (t) => {
  const h = await fixture(t);
  h.db
    .prepare(
      "INSERT INTO subscriptions(account_id,stripe_subscription_id,price_id,status,paid_through_ms,updated_at_ms) VALUES(1,'sub_one','price_monthly','active',1000000,0)",
    )
    .run();
  h.objects.set("/v1/subscriptions/sub_one", {
    id: "sub_one",
    latest_invoice: "in_one",
  });
  h.objects.set("/v1/invoices/in_one", invoice("sub_one"));
  const response = await h.post("/v1/sessions", {
    sessionId: "00000000-0000-0000-0000-000000000001",
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 20n);
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsReserved, 30_000n);
});

test("historical prices fulfill old allowances during catalog mismatch while portal and readiness stay available", async (t) => {
  const h = await fixture(t);
  h.purchase("old_pack");
  for (const [product, hours, briefs] of [
    ["monthly", 7, 14],
    ["pack", 2, 4],
  ] as const)
    h.db.prepare("INSERT INTO catalog_prices VALUES(?,?,?)").run(
      `price_old_${product}`,
      product,
      JSON.stringify({
        ...CATALOG[product],
        version: `older_${product}`,
        hours,
        briefs,
      }),
    );
  h.db.prepare("UPDATE checkouts SET price_id='price_old_pack'").run();
  h.objects.set("/v1/prices/price_pack", {
    ...price("pack"),
    unit_amount: 999,
  });
  const oldPack = pack("old_pack", "pi_old");
  oldPack.line_items.data[0].price = "price_old_pack";
  h.objects.set("/v1/checkout/sessions/cs_old", oldPack);
  assert.equal(
    (
      await h.deliver(
        event(
          "evt_old_pack",
          "checkout.session.async_payment_succeeded",
          "cs_old",
        ),
      )
    ).status,
    200,
  );
  const oldInvoice = invoice("sub_old");
  oldInvoice.lines.data[0].pricing.price_details.price = "price_old_monthly";
  h.objects.set("/v1/invoices/in_old", oldInvoice);
  assert.equal(
    (await h.deliver(event("evt_old_invoice", "invoice.paid", "in_old")))
      .status,
    200,
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
    9n * 3_600_000n,
  );
  assert.equal(balance(h.db, 1n, h.state.clock()).briefsAvailable, 18n);
  assert.equal(
    (
      await h.post("/v1/billing/checkout", {
        product: "pack",
        idempotencyKey: "new",
      })
    ).status,
    503,
  );
  h.objects.set("POST /v1/billing_portal/sessions", {
    url: "https://billing.stripe.com/p/session/test",
  });
  assert.equal((await h.post("/v1/billing/portal", {})).status, 200);
  assert.deepEqual(historical(h.db, "price_old_pack", "pack")?.hours, 2);
  assert.equal((await fetch(h.base + "/readyz")).status, 204);
});

test("unrelated singleton Stripe events are processed without blocking reconciliation", async (t) => {
  const h = await fixture(t);
  h.objects.set("/v1/events", {
    data: [
      {
        id: "evt_tax",
        type: "tax.settings.updated",
        data: { object: { object: "tax.settings" } },
      },
      {
        id: "evt_upcoming",
        type: "invoice.upcoming",
        data: { object: { object: "invoice" } },
      },
      event("evt_product", "product.created", "prod_one"),
    ],
    has_more: false,
  });
  await reconcile(h.state);
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT count(*) AS n FROM billing_events WHERE status='processed'",
      )
      .get(),
    { n: 3n },
  );
  assert.deepEqual(h.db.prepare("SELECT cursor FROM billing_sync").get(), {
    cursor: null,
  });
});

test("legacy catalog recovery requires verified identity and restored enumeration never guesses a Price", async (t) => {
  const h = await fixture(t);
  const archived = {
    ...price("monthly"),
    id: "price_archived",
    active: false,
    metadata: {},
  };
  h.objects.set("/v1/prices/price_archived", archived);
  await assert.rejects(recoverPrice(h.state, "price_archived", "monthly"));
  h.objects.set("/v1/prices/price_archived", {
    ...archived,
    metadata: { savvy_catalog_version: CATALOG.monthly.version },
  });
  assert.deepEqual(
    await recoverPrice(h.state, "price_archived", "monthly"),
    CATALOG.monthly,
  );
  h.db
    .prepare(
      "INSERT INTO checkouts(account_id,request_key,product,state,created_at_ms,search_cursor) VALUES(1,'legacy','monthly','pending',?,'cs_old_search')",
    )
    .run(h.state.clock());
  const directory = await mkdtemp(join(tmpdir(), "savvy-catalog-restore-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "restored.sqlite");
  await h.db.backup(path);
  const restored = openServiceDatabase(path);
  try {
    assert.deepEqual(
      historical(restored, "price_archived", "monthly"),
      CATALOG.monthly,
    );
    assert.deepEqual(
      restored
        .prepare(
          "SELECT price_id,search_cursor,state FROM checkouts WHERE request_key='legacy'",
        )
        .get(),
      { price_id: null, search_cursor: null, state: "pending" },
    );
    assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(restored.pragma("foreign_key_check"), []);
  } finally {
    restored.close();
  }
});

test("concurrent checkout retries retain the original attempt while reconciliation cannot prove absence during creation", async (t) => {
  const h = await fixture(t);
  let status = 500;
  h.setPost(async () => ({
    status,
    body:
      status === 200
        ? {
            id: "cs_one",
            url: "https://checkout.stripe.com/c/pay/test#fragment",
          }
        : { error: { type: "api_error" } },
  }));
  const buy = (key: string) =>
    h.post("/v1/billing/checkout", { product: "pack", idempotencyKey: key });
  assert.equal((await buy("uncertain")).status, 503);
  assert.equal((await buy("different")).status, 503);
  assert.equal(
    accountSummary(h.db, 1n, h.state.clock()).pendingPurchases[0].attemptId,
    "uncertain",
  );
  status = 200;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.setPost(async () => {
    enter();
    await blocked;
    return {
      status: 200,
      body: {
        id: "cs_one",
        url: "https://checkout.stripe.com/c/pay/test#fragment",
      },
    };
  });
  const pending = buy("another");
  await entered;
  try {
    h.advance(86_400_000n);
    h.objects.set("/v1/checkout/sessions", { data: [], has_more: false });
    await reconcilePurchases(h.state);
    const duplicate = await buy("parallel");
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.attemptId, "uncertain");
    assert.deepEqual(
      h.db.prepare("SELECT request_key,state FROM checkouts").all(),
      [{ request_key: "uncertain", state: "pending" }],
    );
  } finally {
    release();
  }
  assert.equal((await pending).status, 200);
  assert.deepEqual(
    h.posts.filter((p) => p.path === "/v1/checkout/sessions").map((p) => p.key),
    Array(3).fill("savvy-checkout-1-uncertain"),
  );
  h.objects.set("/v1/checkout/sessions/cs_one", {
    id: "cs_one",
    status: "open",
    url: "https://checkout.stripe.com/c/pay/test#fragment",
  });
  const duplicate = await Promise.all([buy("device_one"), buy("device_two")]);
  assert.ok(duplicate.every((r) => r.body.attemptId === "uncertain"));
  assert.equal(
    accountSummary(h.db, 1n, h.state.clock()).pendingPurchases.length,
    1,
  );
  assert.equal(
    JSON.stringify(accountSummary(h.db, 1n, h.state.clock()), (_, v) =>
      typeof v === "bigint" ? String(v) : v,
    ).includes("checkout.stripe.com"),
    false,
  );
  h.objects.set("/v1/checkout/sessions/cs_one", {
    id: "cs_one",
    status: "expired",
  });
  assert.equal((await buy("after_expiry")).status, 410);
  assert.equal(accountSummary(h.db, 1n, h.state.clock()).paymentPending, false);
});

test("confirmed rejection allows a new attempt and only complete pagination releases an ambiguous purchase", async (t) => {
  const h = await fixture(t);
  h.setPost(async () => ({
    status: 400,
    body: { error: { type: "invalid_request_error" } },
  }));
  const buy = (key: string) =>
    h.post("/v1/billing/checkout", { product: "monthly", idempotencyKey: key });
  assert.equal((await buy("rejected")).body.code, "purchase_rejected");
  h.advance(86_400_000n);
  h.setPost(async () => ({
    status: 200,
    body: {
      id: "cs_new",
      url: "https://checkout.stripe.com/c/pay/test#fragment",
    },
  }));
  assert.equal((await buy("new")).status, 200);
  h.db
    .prepare("UPDATE checkouts SET stripe_id=NULL WHERE request_key='new'")
    .run();
  h.advance(86_400_000n);
  for (const value of [{}, { data: [], has_more: true }]) {
    h.objects.set("/v1/checkout/sessions", value);
    await reconcilePurchases(h.state);
    assert.equal(
      accountSummary(h.db, 1n, h.state.clock()).paymentPending,
      true,
    );
  }
  h.objects.delete("/v1/checkout/sessions");
  await reconcilePurchases(h.state);
  assert.equal(accountSummary(h.db, 1n, h.state.clock()).paymentPending, true);
  h.objects.set("/v1/checkout/sessions", {
    data: [{ id: "cs_other", metadata: { savvy_key: "other" } }],
    has_more: true,
  });
  await reconcilePurchases(h.state);
  assert.equal(accountSummary(h.db, 1n, h.state.clock()).paymentPending, true);
  h.objects.set(
    "/v1/checkout/sessions?customer=cus_test&limit=100&starting_after=cs_other",
    { data: [], has_more: false },
  );
  await reconcilePurchases(h.state);
  assert.ok(
    h.calls.includes(
      "/v1/checkout/sessions?customer=cus_test&limit=100&starting_after=cs_other",
    ),
  );
  assert.equal(accountSummary(h.db, 1n, h.state.clock()).paymentPending, false);
  assert.equal((await buy("after_recovery")).status, 200);
});

test(
  "actual checkout transport timeout retains its identity for later reconciliation",
  { timeout: 15_000 },
  async (t) => {
    const h = await fixture(t);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.setPost(async () => {
      await blocked;
      return {
        status: 200,
        body: {
          id: "cs_timeout",
          url: "https://checkout.stripe.com/c/pay/test#fragment",
        },
      };
    });
    try {
      const began = performance.now();
      assert.equal(
        (
          await h.post("/v1/billing/checkout", {
            product: "monthly",
            idempotencyKey: "timed_out",
          })
        ).status,
        503,
      );
      assert.ok(performance.now() - began >= 9900);
      assert.equal(
        accountSummary(h.db, 1n, h.state.clock()).pendingPurchases[0].attemptId,
        "timed_out",
      );
      const session = {
        id: "cs_timeout",
        customer: "cus_test",
        status: "open",
        metadata: { savvy_key: "timed_out" },
        url: "https://checkout.stripe.com/c/pay/test#fragment",
      };
      h.objects.set("/v1/checkout/sessions", {
        data: [session],
        has_more: false,
      });
      h.objects.set("/v1/checkout/sessions/cs_timeout", session);
      h.advance(86_400_000n);
      await reconcilePurchases(h.state);
      const retry = await h.post("/v1/billing/checkout", {
        product: "monthly",
        idempotencyKey: "different",
      });
      assert.equal(retry.status, 200);
      assert.equal(retry.body.attemptId, "timed_out");
      assert.equal(h.posts.length, 1);
    } finally {
      release();
    }
  },
);

for (const paymentStatus of ["paid", "no_payment_required"]) {
  test(`zero-total ${paymentStatus} pack checkout grants once without a PaymentIntent`, async (t) => {
    const h = await fixture(t);
    h.purchase("free");
    const value = {
      ...pack("free", "unused"),
      payment_intent: null,
      payment_status: paymentStatus,
      amount_total: 0,
    };
    h.objects.set("/v1/checkout/sessions/cs_free", value);
    for (const id of ["evt_free", "evt_free", "evt_free_replay"])
      assert.equal(
        (await h.deliver(event(id, "checkout.session.completed", "cs_free")))
          .status,
        200,
      );
    assert.equal(
      balance(h.db, 1n, h.state.clock()).meetingMsAvailable,
      10_800_000n,
    );
    assert.equal(
      accountSummary(h.db, 1n, h.state.clock()).paymentPending,
      false,
    );
    assert.deepEqual(
      h.db.prepare("SELECT count(*) AS n FROM allowance_grants").get(),
      { n: 1n },
    );
  });
}

test("no-payment-required status cannot grant an incomplete or nonzero checkout", async (t) => {
  const h = await fixture(t);
  for (const [key, status, amount] of [
    ["open", "open", 0],
    ["nonzero", "complete", 2900],
  ] as const) {
    h.purchase(key);
    h.objects.set(`/v1/checkout/sessions/cs_${key}`, {
      ...pack(key, "unused"),
      payment_intent: null,
      payment_status: "no_payment_required",
      status,
      amount_total: amount,
    });
    assert.equal(
      (
        await h.deliver(
          event(`evt_${key}`, "checkout.session.completed", `cs_${key}`),
        )
      ).status,
      200,
    );
  }
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsAvailable, 0n);
});

async function organizationFixture(t: TestContext) {
  const h = await fixture(t);
  h.db
    .transaction(() =>
      setCapability(h.db, "team_purchase_enabled", "1", h.state.clock()),
    )
    .immediate();
  const org = h.db
    .transaction(() =>
      createOrganization(h.db, 1n, "Fixture team", h.state.clock()),
    )
    .immediate();
  h.objects.set("POST /v1/customers", { id: "cus_org" });
  const checkout: StripeObject = {
    id: "cs_org",
    customer: "cus_org",
    metadata: { savvy_org: org.toString(), savvy_key: "org-buy" },
    payment_status: "unpaid",
    status: "open",
    mode: "subscription",
    line_items: { data: [{ price: "price_monthly", quantity: 5 }] },
    url: "https://checkout.stripe.com/c/org",
  };
  h.objects.set("POST /v1/checkout/sessions", checkout);
  await organizationCheckout(h.state, 1n, org, {
    quantity: 5,
    requestKey: "org-buy",
  });
  Object.assign(checkout, {
    status: "complete",
    payment_status: "paid",
    subscription: "sub_org",
  });
  h.objects.set("/v1/checkout/sessions/cs_org", checkout);
  const subscription: StripeObject = {
    id: "sub_org",
    customer: "cus_org",
    status: "active",
    cancel_at_period_end: false,
    latest_invoice: "in_org",
    items: { data: [{ id: "si_org", quantity: 5, price: "price_monthly" }] },
  };
  h.objects.set("/v1/subscriptions/sub_org", subscription);
  const makeInvoice = (
    id = "in_org",
    quantity = 5,
    start = 1000,
    end = 2000,
  ): StripeObject => ({
    id,
    customer: "cus_org",
    status: "paid",
    currency: "usd",
    billing_reason:
      id === "in_org" ? "subscription_create" : "subscription_cycle",
    amount_paid: quantity * CATALOG.monthly.amountCents,
    lines: {
      data: [
        {
          pricing: { price_details: { price: "price_monthly" } },
          quantity,
          period: { start, end },
          parent: {
            subscription_item_details: {
              subscription_item: "si_org",
              proration: false,
            },
          },
        },
      ],
    },
    parent: { subscription_details: { subscription: "sub_org" } },
  });
  h.objects.set("/v1/invoices/in_org", makeInvoice());
  return { ...h, org, checkout, subscription, makeInvoice };
}

test("organization invoice before checkout notification fulfills through signed HTTP and replays without personal spending", async (t) => {
  const h = await organizationFixture(t);
  assert.equal(
    (await h.deliver(event("evt_org_invoice", "invoice.paid", "in_org")))
      .status,
    200,
  );
  assert.equal(
    (
      await h.deliver(
        event("evt_org_checkout", "checkout.session.completed", "cs_org"),
      )
    ).status,
    200,
  );
  for (let replay = 0; replay < 2; replay++)
    assert.equal(
      (await h.deliver(event("evt_org_duplicate", "invoice.paid", "in_org")))
        .status,
      200,
    );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM seat_periods")
      .get()!.n,
    5n,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM allowance_grants WHERE kind='seat'",
      )
      .get()!.n,
    0n,
  );
  const assignment = h.db
    .transaction(() => assignSeat(h.db, 1n, h.org, 1n, h.state.clock(), 1n))
    .immediate();
  assert.equal(balance(h.db, 1n, h.state.clock()).meetingMsAvailable, 0n);
  assert.equal(
    balance(h.db, 1n, h.state.clock(), {
      kind: "organization",
      organizationId: h.org,
      assignmentId: BigInt(assignment.assignmentId),
    }).briefsAvailable,
    20n,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM stripe_payments")
      .get()!.n,
    0n,
  );
  assert.deepEqual(
    h.db.prepare("SELECT stripe_customer_id FROM accounts WHERE id=1").get(),
    { stripe_customer_id: "cus_test" },
  );
});

test("future organization invoices stay pending and gap filling preserves paid holders until the new period", async (t) => {
  const h = await organizationFixture(t);
  await processEvent(
    h.state,
    event("evt_org_initial", "invoice.paid", "in_org"),
  );
  const assignment = h.db
    .transaction(() => assignSeat(h.db, 1n, h.org, 1n, h.state.clock(), 1n))
    .immediate();
  h.objects.set(
    "/v1/invoices/in_future",
    h.makeInvoice("in_future", 3, 2000, 3000),
  );
  Object.assign(h.subscription, {
    latest_invoice: "in_future",
    items: { data: [{ id: "si_org", quantity: 3, price: "price_monthly" }] },
  });
  const future = await h.deliver(
    event("evt_org_future", "invoice.paid", "in_future"),
  );
  assert.equal(future.status, 402);
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT status FROM billing_events WHERE stripe_event_id='evt_org_future'",
      )
      .get(),
    { status: "pending" },
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM seats WHERE status<>'retired'",
      )
      .get()!.n,
    5n,
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock(), {
      kind: "organization",
      organizationId: h.org,
      assignmentId: BigInt(assignment.assignmentId),
    }).briefsAvailable,
    20n,
  );
  h.advance(1_000_000n);
  assert.equal(
    (await h.deliver(event("evt_org_future", "invoice.paid", "in_future")))
      .status,
    200,
  );
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
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM seat_periods")
      .get()!.n,
    8n,
  );
  assert.equal(
    (
      await h.deliver({
        ...event("evt_org_stale", "customer.subscription.updated", "sub_org"),
        created: 1,
      })
    ).status,
    200,
  );
  assert.equal(
    h.db
      .prepare<[], { quantity_next: bigint }>(
        "SELECT quantity_next FROM organization_subscriptions",
      )
      .get()!.quantity_next,
    3n,
  );
});

test("organization reversal before fulfillment and a canonical dispute win never erase an unseen partial refund", async (t) => {
  const h = await organizationFixture(t);
  h.objects.set("/v1/charges/ch_org", {
    id: "ch_org",
    customer: "cus_org",
    payment_intent: "pi_org",
    invoice: "in_org",
    amount_refunded: 1,
  });
  h.objects.set("/v1/disputes/dp_org", {
    id: "dp_org",
    charge: "ch_org",
    status: "won",
  });
  assert.equal(
    (
      await h.deliver(
        event("evt_org_won_first", "charge.dispute.closed", "dp_org"),
      )
    ).status,
    200,
  );
  assert.equal(
    (await h.deliver(event("evt_org_paid_refunded", "invoice.paid", "in_org")))
      .status,
    200,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM seat_periods WHERE financial_status='reversed'",
      )
      .get()!.n,
    5n,
  );
  assert.throws(
    () =>
      h.db
        .transaction(() => assignSeat(h.db, 1n, h.org, 1n, h.state.clock(), 1n))
        .immediate(),
    { code: "quota_exhausted" },
  );
  assert.equal(
    (
      await h.deliver(
        event("evt_org_late_open", "charge.dispute.created", "dp_org"),
      )
    ).status,
    200,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM organization_reversals WHERE kind='refund'",
      )
      .get()!.n,
    1n,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM reversals")
      .get()!.n,
    0n,
  );
});

test("organization dispute restoration is scoped to its invoice while closed inquiries and later renewals stay eligible", async (t) => {
  const h = await organizationFixture(t);
  await processEvent(h.state, event("evt_org_paid", "invoice.paid", "in_org"));
  const assignment = h.db
    .transaction(() => assignSeat(h.db, 1n, h.org, 1n, h.state.clock(), 1n))
    .immediate();
  const funding = {
    kind: "organization" as const,
    organizationId: h.org,
    assignmentId: BigInt(assignment.assignmentId),
  };
  h.objects.set("/v1/charges/ch_org", {
    id: "ch_org",
    customer: "cus_org",
    payment_intent: "pi_org",
    invoice: "in_org",
    amount_refunded: 0,
  });
  const dispute = { id: "dp_org", charge: "ch_org", status: "needs_response" };
  h.objects.set("/v1/disputes/dp_org", dispute);
  await processEvent(
    h.state,
    event("evt_org_dispute", "charge.dispute.created", "dp_org"),
  );
  assert.throws(() => balance(h.db, 1n, h.state.clock(), funding), {
    code: "no_seat",
  });
  dispute.status = "won";
  await processEvent(
    h.state,
    event("evt_org_dispute_won", "charge.dispute.closed", "dp_org"),
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock(), funding).briefsAvailable,
    20n,
  );
  dispute.status = "warning_closed";
  await processEvent(
    h.state,
    event("evt_org_inquiry_closed", "charge.dispute.closed", "dp_org"),
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock(), funding).briefsAvailable,
    20n,
  );
  h.advance(1_000_000n);
  h.objects.set(
    "/v1/invoices/in_org_renew",
    h.makeInvoice("in_org_renew", 5, 2000, 3000),
  );
  h.subscription.latest_invoice = "in_org_renew";
  h.objects.set("/v1/events?limit=100", { data: [], has_more: false });
  await reconcile(h.state);
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM seat_periods")
      .get()!.n,
    10n,
  );
  Object.assign(h.objects.get("/v1/charges/ch_org")!, { amount_refunded: 1 });
  await processEvent(
    h.state,
    event("evt_org_old_refund", "charge.refunded", "ch_org"),
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock(), funding).briefsAvailable,
    20n,
  );
});

test("organization invoice rejects unknown subscription, wrong quantity and proration without minting allowance", async (t) => {
  const h = await organizationFixture(t);
  const bad = h.makeInvoice("in_bad", 5);
  h.objects.set("/v1/invoices/in_bad", bad);
  Object.assign(bad, {
    lines: {
      data: [
        {
          pricing: { price_details: { price: "price_monthly" } },
          quantity: 5,
          period: { start: 1000, end: 2000 },
          parent: {
            subscription_item_details: {
              subscription_item: "si_org",
              proration: true,
            },
          },
        },
      ],
    },
  });
  assert.equal(
    (await h.deliver(event("evt_org_bad", "invoice.paid", "in_bad"))).status,
    400,
  );
  h.objects.set("/v1/invoices/in_bad", { ...h.makeInvoice("in_bad", 0) });
  assert.equal(
    (await h.deliver(event("evt_org_zero", "invoice.paid", "in_bad"))).status,
    400,
  );
  const mismatch = {
    ...h.makeInvoice(),
    lines: {
      data: [
        {
          pricing: { price_details: { price: "price_monthly" } },
          quantity: 4,
          period: { start: 1000, end: 2000 },
          parent: {
            subscription_item_details: {
              subscription_item: "si_org",
              proration: false,
            },
          },
        },
      ],
    },
  };
  h.objects.set("/v1/invoices/in_org", mismatch);
  assert.equal(
    (await h.deliver(event("evt_org_mismatch", "invoice.paid", "in_org")))
      .status,
    400,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM allowance_grants")
      .get()!.n,
    0n,
  );
});

test("Basil charge lookup finds its invoice without a charge.invoice field and rejects an unrelated subscription", async (t) => {
  const h = await organizationFixture(t);
  h.objects.set("/v1/charges/ch_basil", {
    id: "ch_basil",
    customer: "cus_org",
    payment_intent: "pi_basil",
    amount_refunded: 1,
  });
  h.objects.set("/v1/invoice_payments", {
    data: [{ id: "ip_basil", invoice: "in_org" }],
    has_more: false,
  });
  assert.equal(
    (await h.deliver(event("evt_basil_org", "charge.refunded", "ch_basil")))
      .status,
    200,
  );
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT owner_kind FROM stripe_customers WHERE stripe_customer_id='cus_org'",
      )
      .get(),
    { owner_kind: "organization" },
  );
  await processEvent(
    h.state,
    event("evt_basil_paid", "invoice.paid", "in_org"),
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM seat_periods WHERE financial_status='reversed'",
      )
      .get()!.n,
    5n,
  );
  h.objects.set("/v1/subscriptions/sub_unknown", {
    ...h.subscription,
    id: "sub_unknown",
  });
  h.objects.set("/v1/invoices/in_unknown", {
    ...h.makeInvoice("in_unknown"),
    parent: { subscription_details: { subscription: "sub_unknown" } },
  });
  assert.equal(
    (
      await h.deliver(
        event("evt_org_unknown_sub", "invoice.paid", "in_unknown"),
      )
    ).status,
    400,
  );
});

test("replacement subscription keeps old checkout/item history and late historical invoices cannot alter the new allowance", async (t) => {
  const h = await organizationFixture(t);
  await processEvent(h.state, event("evt_old_paid", "invoice.paid", "in_org"));
  const assigned = h.db
    .transaction(() => assignSeat(h.db, 1n, h.org, 1n, h.state.clock(), 1n))
    .immediate();
  h.advance(1_000_000n);
  h.subscription.status = "canceled";
  await processEvent(
    h.state,
    event("evt_old_canceled", "customer.subscription.deleted", "sub_org"),
  );
  const checkout = {
    ...h.checkout,
    id: "cs_new",
    status: "open",
    payment_status: "unpaid",
    subscription: null,
    metadata: { savvy_org: h.org.toString(), savvy_key: "new-buy" },
    line_items: { data: [{ price: "price_monthly", quantity: 2 }] },
  };
  h.objects.set("POST /v1/checkout/sessions", checkout);
  await organizationCheckout(h.state, 1n, h.org, {
    quantity: 2,
    requestKey: "new-buy",
  });
  Object.assign(checkout, {
    status: "complete",
    payment_status: "paid",
    subscription: "sub_new",
  });
  h.objects.set("/v1/checkout/sessions/cs_new", checkout);
  h.objects.set("/v1/subscriptions/sub_new", {
    ...h.subscription,
    id: "sub_new",
    status: "active",
    latest_invoice: "in_new",
    items: { data: [{ id: "si_new", quantity: 2, price: "price_monthly" }] },
  });
  h.objects.set("/v1/invoices/in_new", {
    ...h.makeInvoice("in_new", 2, 2000, 3000),
    parent: { subscription_details: { subscription: "sub_new" } },
    lines: {
      data: [
        {
          quantity: 2,
          pricing: { price_details: { price: "price_monthly" } },
          period: { start: 2000, end: 3000 },
          parent: {
            subscription_item_details: {
              subscription_item: "si_new",
              proration: false,
            },
          },
        },
      ],
    },
  });
  assert.equal(
    (await h.deliver(event("evt_new_paid", "invoice.paid", "in_new"))).status,
    200,
  );
  h.objects.set(
    "/v1/invoices/in_historical",
    h.makeInvoice("in_historical", 5, 500, 1000),
  );
  assert.equal(
    (
      await h.deliver(
        event("evt_late_historical", "invoice.paid", "in_historical"),
      )
    ).status,
    200,
  );
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT stripe_subscription_id,paid_through_ms FROM organization_subscriptions",
      )
      .get(),
    { stripe_subscription_id: "sub_new", paid_through_ms: 3_000_000n },
  );
  assert.equal(
    balance(h.db, 1n, h.state.clock(), {
      kind: "organization",
      organizationId: h.org,
      assignmentId: BigInt(assigned.assignmentId),
    }).briefsAvailable,
    20n,
  );
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM allowance_grants")
      .get()!.n,
    2n,
  );
});

test("reconciliation retries a durable quantity intent with its original key and cannot reapply an older canonical snapshot", async (t) => {
  const h = await organizationFixture(t);
  await processEvent(
    h.state,
    event("evt_recovery_paid", "invoice.paid", "in_org"),
  );
  h.db
    .prepare(
      "INSERT INTO organization_quantity_changes(organization_id,request_key,quantity,retire_seat_ids,previous_retire_seat_ids,stripe_idempotency_key,stripe_subscription_id,stripe_item_id,price_id,state,created_at_ms) VALUES(?,'recover',3,'[\"4\",\"5\"]','[]','original-quantity-key','sub_org','si_org','price_monthly','unknown',?)",
    )
    .run(h.org, h.state.clock());
  h.db.prepare("UPDATE seats SET status='retiring' WHERE id IN(4,5)").run();
  h.setPost(async (path) => {
    assert.equal(path, "/v1/subscriptions/sub_org");
    h.subscription.items = {
      data: [{ id: "si_org", price: "price_monthly", quantity: 3 }],
    };
    return { status: 200, body: h.subscription };
  });
  assert.equal(
    (
      await h.deliver(
        event("evt_recovery_sub", "customer.subscription.updated", "sub_org"),
      )
    ).status,
    200,
  );
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT quantity_next,external_change FROM organization_subscriptions",
      )
      .get(),
    { quantity_next: 3n, external_change: 0n },
  );
  assert.deepEqual(
    h.db.prepare("SELECT state FROM organization_quantity_changes").get(),
    { state: "applied" },
  );
  const retry = h.posts.find((p) => p.path === "/v1/subscriptions/sub_org")!;
  assert.equal(retry.key, "original-quantity-key");
  assert.equal(retry.form.get("proration_behavior"), "none");
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM seats WHERE status<>'retired'",
      )
      .get()!.n,
    5n,
  );
});
