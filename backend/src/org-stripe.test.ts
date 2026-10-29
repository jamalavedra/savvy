import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { openServiceDatabase } from "./db.js";
import { configuration } from "./config.js";
import { ServiceState } from "./state.js";
import { CATALOG } from "./catalog.js";
import { setCapability, disableTeamPurchases } from "./capability.js";
import { createOrganization, transferOwner, assignSeat } from "./org.js";
import {
  acquireBilling,
  bindCustomer,
  resolveCustomer,
  type StripeObject,
} from "./stripe.js";
import {
  organizationCheckout,
  organizationPortal,
  updateSeatQuantity,
} from "./org-stripe.js";

async function fixture(t: TestContext) {
  const calls: {
    path: string;
    method: string;
    key: string | undefined;
    form: URLSearchParams;
  }[] = [];
  let rejectCheckout = false,
    unknownCheckout = false;
  let quantity = 2,
    quantityFailure = 0;
  const sessions = new Map<string, StripeObject>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw),
      path = url.pathname;
    calls.push({
      path,
      method: req.method!,
      key: req.headers["idempotency-key"] as string | undefined,
      form,
    });
    assert.equal(req.headers["stripe-version"], "2025-06-30.basil");
    let body: StripeObject = {};
    if (path === "/v1/prices/price_monthly")
      body = {
        id: "price_monthly",
        active: true,
        currency: "usd",
        unit_amount: CATALOG.monthly.amountCents,
        billing_scheme: "per_unit",
        transform_quantity: null,
        type: "recurring",
        recurring: {
          interval: "month",
          interval_count: 1,
          usage_type: "licensed",
        },
        metadata: { savvy_catalog_version: CATALOG.monthly.version },
      };
    else if (path === "/v1/customers") body = { id: "cus_team" };
    else if (path === "/v1/checkout/sessions" && req.method === "POST") {
      if (rejectCheckout || unknownCheckout) {
        res.writeHead(rejectCheckout ? 400 : 503, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify({
            error: {
              type: rejectCheckout ? "invalid_request_error" : "api_error",
            },
          }),
        );
        return;
      }
      const id = "cs_team";
      body = {
        id,
        customer: form.get("customer"),
        mode: form.get("mode"),
        status: "open",
        payment_status: "unpaid",
        metadata: {
          savvy_org: form.get("metadata[savvy_org]"),
          savvy_key: form.get("metadata[savvy_key]"),
        },
        line_items: {
          data: [
            {
              price: form.get("line_items[0][price]"),
              quantity: Number(form.get("line_items[0][quantity]")),
            },
          ],
        },
        url: "https://checkout.stripe.com/c/team",
      };
      sessions.set(id, body);
    } else if (path === "/v1/checkout/sessions" && req.method === "GET")
      body = { data: [...sessions.values()], has_more: false };
    else if (path.startsWith("/v1/checkout/sessions/"))
      body = sessions.get(path.split("/").at(-1)!) ?? {};
    else if (path === "/v1/subscriptions/sub_old")
      body = {
        id: "sub_old",
        customer: "cus_team",
        status: "canceled",
        latest_invoice: null,
        items: {
          data: [{ id: "si_old", price: "price_monthly", quantity: 2 }],
        },
      };
    else if (path === "/v1/subscriptions/sub_team") {
      if (req.method === "POST") {
        if (quantityFailure) {
          res.writeHead(quantityFailure, {
            "content-type": "application/json",
          });
          res.end(
            JSON.stringify({
              error: {
                type:
                  quantityFailure === 400
                    ? "invalid_request_error"
                    : "api_error",
              },
            }),
          );
          return;
        }
        quantity = Number(form.get("items[0][quantity]"));
      }
      body = {
        id: "sub_team",
        customer: "cus_team",
        status: "active",
        items: { data: [{ id: "si_team", price: "price_monthly", quantity }] },
      };
    } else if (path === "/v1/billing_portal/configurations/bpc_team")
      body = {
        id: "bpc_team",
        active: true,
        features: {
          subscription_update: { enabled: false },
          subscription_cancel: { enabled: true },
        },
      };
    else if (path === "/v1/billing_portal/sessions")
      body = { url: "https://billing.stripe.com/p/team" };
    else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const db = openServiceDatabase(":memory:");
  t.after(() => db.close());
  const tx = <T>(fn: () => T) => db.transaction(fn).immediate();
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','owner',0),(2,'issuer','member',0)",
  ).run();
  let now = 1_700_000_000_000n;
  tx(() => setCapability(db, "team_purchase_enabled", "1", now));
  const org = tx(() => createOrganization(db, 1n, "Team", now));
  db.prepare(
    "INSERT INTO organization_members VALUES(?,2,'member','member@example.test',?)",
  ).run(org, now);
  const state = new ServiceState(
    configuration({
      BETTER_AUTH_URL: base,
      SAVVY_STRIPE_BASE_URL: base,
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
  return {
    db,
    tx,
    state,
    org,
    calls,
    sessions,
    quantityFailure: (status: number) => {
      quantityFailure = status;
    },
    now: () => now,
    advance: (ms: bigint) => {
      now += ms;
    },
    reject: (value: boolean) => {
      rejectCheckout = value;
    },
    unknown: (value: boolean) => {
      unknownCheckout = value;
    },
  };
}

test("organization and account customers and billing locks are exclusive even with equal numeric IDs", async (t) => {
  const h = await fixture(t);
  const personal = acquireBilling(h.state, "account:1"),
    organization = acquireBilling(h.state, "org:1");
  assert.equal(h.state.billingInFlight.size, 2);
  personal();
  organization();
  h.tx(() => bindCustomer(h.db, "account", 1n, "cus_personal"));
  assert.deepEqual(resolveCustomer(h.db, "cus_personal"), {
    owner_kind: "account",
    owner_id: 1n,
  });
  assert.throws(
    () => h.tx(() => bindCustomer(h.db, "organization", h.org, "cus_personal")),
    { code: "invalid_request" },
  );
  assert.equal(
    h.db
      .prepare<[bigint], { stripe_customer_id: string | null }>(
        "SELECT stripe_customer_id FROM organizations WHERE id=?",
      )
      .get(h.org)!.stripe_customer_id,
    null,
  );
});

test("team checkout pins quantity and payer and reuses its durable Stripe attempt across owner transfer", async (t) => {
  const h = await fixture(t);
  const first = await organizationCheckout(h.state, 1n, h.org, {
    quantity: 5,
    requestKey: "buy-five",
  });
  assert.equal(first.url, "https://checkout.stripe.com/c/team");
  const created = h.calls.find(
    (c) => c.path === "/v1/checkout/sessions" && c.method === "POST",
  )!;
  assert.equal(created.form.get("line_items[0][quantity]"), "5");
  assert.equal(created.form.get("client_reference_id"), "org:1");
  assert.equal(created.form.get("subscription_data[metadata][savvy_org]"), "1");
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM allowance_grants")
      .get()!.n,
    0n,
  );
  await assert.rejects(
    organizationCheckout(h.state, 1n, h.org, {
      quantity: 6,
      requestKey: "buy-five",
    }),
    { code: "checkout_mismatch" },
  );
  await assert.rejects(
    organizationCheckout(h.state, 1n, h.org, {
      quantity: 5,
      requestKey: "second",
    }),
    { code: "payment_pending" },
  );
  h.tx(() => transferOwner(h.db, 1n, h.org, 2n));
  disableTeamPurchases(h.db, h.now());
  await assert.rejects(
    organizationCheckout(h.state, 1n, h.org, {
      quantity: 5,
      requestKey: "buy-five",
    }),
    { status: 403 },
  );
  const retry = await organizationCheckout(h.state, 2n, h.org, {
    quantity: 5,
    requestKey: "buy-five",
  });
  assert.equal(retry.url, first.url);
  assert.equal(
    h.calls.filter(
      (c) => c.path === "/v1/checkout/sessions" && c.method === "POST",
    ).length,
    1,
  );
  await assert.rejects(
    organizationCheckout(h.state, 2n, h.org, {
      quantity: 1,
      requestKey: "new-disabled",
    }),
    { code: "team_purchase_disabled" },
  );
});

test("unknown checkout outcomes keep a durable barrier and retry only the original provider key", async (t) => {
  const h = await fixture(t);
  h.unknown(true);
  await assert.rejects(
    organizationCheckout(h.state, 1n, h.org, {
      quantity: 2,
      requestKey: "timeout",
    }),
    { code: "provider_unavailable" },
  );
  assert.equal(
    h.db
      .prepare<[], { state: string }>(
        "SELECT state FROM organization_checkouts",
      )
      .get()!.state,
    "unknown",
  );
  await assert.rejects(
    organizationCheckout(h.state, 1n, h.org, {
      quantity: 2,
      requestKey: "different",
    }),
    { code: "payment_pending" },
  );
  h.unknown(false);
  await organizationCheckout(h.state, 1n, h.org, {
    quantity: 2,
    requestKey: "timeout",
  });
  const attempts = h.calls.filter(
    (c) => c.path === "/v1/checkout/sessions" && c.method === "POST",
  );
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].key, attempts[1].key);
  assert.equal(
    h.calls.some(
      (c) => c.path === "/v1/checkout/sessions" && c.method === "GET",
    ),
    true,
  );
  assert.equal(h.state.billingInFlight.size, 0);
});

test("an unknown attempt outside Stripe's retained-key window cannot silently create a new purchase", async (t) => {
  const h = await fixture(t);
  h.unknown(true);
  await assert.rejects(
    organizationCheckout(h.state, 1n, h.org, {
      quantity: 2,
      requestKey: "old",
    }),
  );
  h.unknown(false);
  h.advance(24n * 3_600_000n);
  await assert.rejects(
    organizationCheckout(h.state, 1n, h.org, {
      quantity: 2,
      requestKey: "old",
    }),
    { code: "payment_pending" },
  );
  assert.equal(
    h.calls.filter(
      (c) => c.path === "/v1/checkout/sessions" && c.method === "POST",
    ).length,
    1,
  );
});

test("definitive checkout rejection ends only that intent and team portal uses only the team customer", async (t) => {
  const h = await fixture(t);
  h.reject(true);
  await assert.rejects(
    organizationCheckout(h.state, 1n, h.org, {
      quantity: 2,
      requestKey: "rejected",
    }),
    { code: "purchase_rejected" },
  );
  assert.equal(
    h.db
      .prepare<[], { state: string }>(
        "SELECT state FROM organization_checkouts",
      )
      .get()!.state,
    "failed",
  );
  h.reject(false);
  await organizationCheckout(h.state, 1n, h.org, {
    quantity: 2,
    requestKey: "valid",
  });
  await assert.rejects(organizationPortal(h.state, 2n, h.org), { status: 403 });
  h.tx(() =>
    setCapability(
      h.db,
      "organization_portal_configuration_id",
      "bpc_team",
      h.now(),
    ),
  );
  assert.equal(
    (await organizationPortal(h.state, 1n, h.org)).url,
    "https://billing.stripe.com/p/team",
  );
  const portal = h.calls.find((c) => c.path === "/v1/billing_portal/sessions")!;
  assert.equal(portal.form.get("customer"), "cus_team");
  assert.equal(portal.form.get("configuration"), "bpc_team");
});

function paidTeam(h: Awaited<ReturnType<typeof fixture>>) {
  h.tx(() => bindCustomer(h.db, "organization", h.org, "cus_team"));
  h.db
    .prepare(
      "INSERT INTO organization_subscriptions(organization_id,stripe_subscription_id,stripe_item_id,price_id,status,quantity_next,updated_at_ms) VALUES(?,'sub_team','si_team','price_monthly','active',2,?)",
    )
    .run(h.org, h.now());
  for (let n = 1; n <= 2; n++) {
    h.db
      .prepare(
        "INSERT INTO seats(id,organization_id,seat_number,status,created_at_ms) VALUES(?, ?,?,'active',?)",
      )
      .run(n, h.org, n, h.now());
    h.db
      .prepare(
        "INSERT INTO seat_periods(organization_id,seat_id,invoice_id,starts_ms,ends_ms,price_id,budget_ms,budget_briefs,financial_status) VALUES(?,?,'in_team',?,?,'price_monthly',36000000,20,'paid')",
      )
      .run(h.org, n, h.now(), h.now() + 100_000n);
  }
}

test("seat changes use the known item and no proration, block retiring admission and create no current capacity", async (t) => {
  const h = await fixture(t);
  paidTeam(h);
  const result = await updateSeatQuantity(h.state, 1n, h.org, {
    quantity: 1,
    retireSeatIds: ["2"],
    requestKey: "decrease",
  });
  assert.equal(result.effective, "next_paid_renewal");
  const changed = h.calls.find(
    (c) => c.path === "/v1/subscriptions/sub_team" && c.method === "POST",
  )!;
  assert.equal(changed.form.get("items[0][id]"), "si_team");
  assert.equal(changed.form.get("proration_behavior"), "none");
  assert.equal(changed.form.has("billing_cycle_anchor"), false);
  assert.throws(
    () => h.tx(() => assignSeat(h.db, 1n, h.org, 2n, h.now(), 2n)),
    { code: "quota_exhausted" },
  );
  await updateSeatQuantity(h.state, 1n, h.org, {
    quantity: 2,
    retireSeatIds: [],
    requestKey: "cancel-decrease",
  });
  assert.equal(
    h.db
      .prepare<[], { status: string }>("SELECT status FROM seats WHERE id=2")
      .get()!.status,
    "active",
  );
  h.tx(() => assignSeat(h.db, 1n, h.org, 2n, h.now(), 2n));
  await assert.rejects(
    updateSeatQuantity(h.state, 1n, h.org, {
      quantity: 1,
      retireSeatIds: ["2"],
      requestKey: "occupied",
    }),
    { code: "invalid_request" },
  );
  await updateSeatQuantity(h.state, 1n, h.org, {
    quantity: 5,
    retireSeatIds: [],
    requestKey: "increase",
  });
  assert.equal(
    h.db.prepare<[], { n: bigint }>("SELECT count(*) AS n FROM seats").get()!.n,
    2n,
  );
  await assert.rejects(
    updateSeatQuantity(h.state, 1n, h.org, {
      quantity: 4,
      retireSeatIds: [],
      requestKey: "increase",
    }),
    { code: "checkout_mismatch" },
  );
});

test("uncertain seat changes keep their barrier while a definitive rejection restores the prior retirement plan", async (t) => {
  const h = await fixture(t);
  paidTeam(h);
  h.quantityFailure(503);
  const body = { quantity: 1, retireSeatIds: ["2"], requestKey: "uncertain" };
  await assert.rejects(updateSeatQuantity(h.state, 1n, h.org, body), {
    code: "provider_unavailable",
  });
  await assert.rejects(
    updateSeatQuantity(h.state, 1n, h.org, { ...body, requestKey: "another" }),
    { code: "payment_pending" },
  );
  assert.throws(
    () => h.tx(() => assignSeat(h.db, 1n, h.org, 2n, h.now(), 2n)),
    { code: "quota_exhausted" },
  );
  h.quantityFailure(400);
  await assert.rejects(updateSeatQuantity(h.state, 1n, h.org, body), {
    code: "purchase_rejected",
  });
  assert.equal(
    h.db
      .prepare<[], { status: string }>("SELECT status FROM seats WHERE id=2")
      .get()!.status,
    "active",
  );
  h.quantityFailure(0);
  await updateSeatQuantity(h.state, 1n, h.org, { ...body, requestKey: "new" });
  assert.equal(h.state.billingInFlight.size, 0);
});

test("an expired quantity idempotency key cannot change Stripe again or attach to a replacement subscription", async (t) => {
  const h = await fixture(t);
  paidTeam(h);
  h.quantityFailure(503);
  const body = { quantity: 1, retireSeatIds: ["2"], requestKey: "old-change" };
  await assert.rejects(updateSeatQuantity(h.state, 1n, h.org, body), {
    code: "provider_unavailable",
  });
  h.quantityFailure(0);
  h.advance(24n * 3_600_000n);
  await assert.rejects(updateSeatQuantity(h.state, 1n, h.org, body), {
    code: "payment_pending",
  });
  assert.equal(
    h.calls.filter(
      (c) => c.path === "/v1/subscriptions/sub_team" && c.method === "POST",
    ).length,
    1,
  );
  h.db
    .prepare(
      "UPDATE organization_subscriptions SET stripe_subscription_id='sub_replacement' WHERE organization_id=?",
    )
    .run(h.org);
  await assert.rejects(updateSeatQuantity(h.state, 1n, h.org, body), {
    code: "payment_pending",
  });
  assert.equal(
    h.calls.some((c) => c.path === "/v1/subscriptions/sub_replacement"),
    false,
  );
});

test("a canceled subscription's remaining paid window blocks another team purchase", async (t) => {
  const h = await fixture(t);
  h.db
    .prepare(
      "INSERT INTO organization_subscriptions(organization_id,stripe_subscription_id,price_id,status,quantity_next,paid_through_ms,updated_at_ms) VALUES(?,'sub_old','price_monthly','canceled',2,?,?)",
    )
    .run(h.org, h.now() + 100_000n, h.now());
  await assert.rejects(
    organizationCheckout(h.state, 1n, h.org, {
      quantity: 2,
      requestKey: "too-early",
    }),
    { code: "session_conflict" },
  );
  assert.equal(
    h.calls.some(
      (c) => c.path === "/v1/checkout/sessions" && c.method === "POST",
    ),
    false,
  );
});

test("a completed replacement checkout replaces an ended subscription while retaining the old purchase linkage", async (t) => {
  const h = await fixture(t);
  h.tx(() => bindCustomer(h.db, "organization", h.org, "cus_team"));
  h.db
    .prepare(
      "INSERT INTO organization_subscriptions(organization_id,stripe_subscription_id,price_id,status,quantity_next,paid_through_ms,updated_at_ms) VALUES(?,'sub_old','price_monthly','canceled',2,0,?)",
    )
    .run(h.org, h.now());
  h.db
    .prepare(
      "INSERT INTO organization_checkouts(organization_id,request_key,quantity,price_id,return_url,stripe_idempotency_key,stripe_session_id,stripe_subscription_id,state,created_at_ms,updated_at_ms) VALUES(?,'old',2,'price_monthly','https://savvy.test/team','old-key','cs_old','sub_old','complete',0,0)",
    )
    .run(h.org);
  await organizationCheckout(h.state, 1n, h.org, {
    quantity: 2,
    requestKey: "replacement",
  });
  Object.assign(h.sessions.get("cs_team")!, {
    status: "complete",
    payment_status: "paid",
    subscription: "sub_team",
  });
  await organizationCheckout(h.state, 1n, h.org, {
    quantity: 2,
    requestKey: "replacement",
  });
  assert.equal(
    h.db
      .prepare<[], { stripe_subscription_id: string }>(
        "SELECT stripe_subscription_id FROM organization_subscriptions",
      )
      .get()!.stripe_subscription_id,
    "sub_team",
  );
  assert.equal(
    h.db
      .prepare<[], { stripe_subscription_id: string }>(
        "SELECT stripe_subscription_id FROM organization_checkouts WHERE request_key='old'",
      )
      .get()!.stripe_subscription_id,
    "sub_old",
  );
});
