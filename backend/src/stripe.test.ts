import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { openServiceDatabase } from "./db.js";
import { ServiceState } from "./state.js";
import { configuration } from "./config.js";
import {
  acquireBilling,
  get,
  post,
  hostedUrl,
  stripeId,
  checkout,
  verifySignature,
} from "./stripe.js";
import { CATALOG, historical, recoverPrice, validatePrice } from "./catalog.js";

test("Stripe transport keeps uncertain purchases unresolved and catalog associations immutable", async (t) => {
  let status = 200;
  let body: unknown = {};
  let calls = 0;
  let expectedKey = "same-key";
  let purchaseFlow = false;
  let createdStatus = 503;
  let checkoutStatus = "open";
  let createCalls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, "Bearer synthetic");
    assert.equal(req.headers["stripe-version"], "2025-06-30.basil");
    if (req.method === "POST") {
      assert.equal(req.headers["idempotency-key"], expectedKey);
      let data = "";
      for await (const chunk of req) data += chunk;
      assert.equal(new URLSearchParams(data).get("customer"), "cus_test");
    }
    if (purchaseFlow) {
      if (req.url?.startsWith("/v1/prices/")) {
        const product = req.url.endsWith("price_monthly") ? "monthly" : "pack";
        const offer = CATALOG[product];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `price_${product}`,
            active: true,
            currency: offer.currency,
            unit_amount: offer.amountCents,
            billing_scheme: "per_unit",
            transform_quantity: null,
            type: offer.interval ? "recurring" : "one_time",
            recurring: offer.interval
              ? {
                  interval: offer.interval,
                  interval_count: 1,
                  usage_type: "licensed",
                }
              : null,
            metadata: { savvy_catalog_version: offer.version },
          }),
        );
        return;
      }
      if (req.method === "POST") createCalls++;
      res.writeHead(req.method === "POST" ? createdStatus : 200, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify({
          id:
            expectedKey === "savvy-checkout-1-fresh" ? "cs_fresh" : "cs_known",
          status: checkoutStatus,
          url: "https://checkout.stripe.com/c/pay",
        }),
      );
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const db = openServiceDatabase(":memory:");
  t.after(async () => {
    db.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const config = configuration({
    BETTER_AUTH_URL: base,
    SAVVY_ANTHROPIC_API_KEY: "synthetic",
    SAVVY_DEEPGRAM_API_KEY: "synthetic",
    SAVVY_STRIPE_SECRET_KEY: "synthetic",
    SAVVY_STRIPE_WEBHOOK_SECRET: "synthetic",
    SAVVY_STRIPE_PRICE_MONTHLY: "price_monthly",
    SAVVY_STRIPE_PRICE_PACK: "price_pack",
    SAVVY_STRIPE_BASE_URL: base,
  });
  const state = new ServiceState(
    config,
    db,
    () => 1000n,
    async () => {
      throw new Error("unused authorizer");
    },
  );
  for (const code of [400, 401, 402, 403, 404, 422, 409, 429, 500, 503]) {
    status = code;
    body = { error: { type: "card_error" } };
    await assert.rejects(
      post(state, "checkout/sessions", "same-key", [["customer", "cus_test"]]),
      {
        code: [409, 429, 500, 503].includes(code)
          ? "provider_unavailable"
          : "purchase_rejected",
      },
    );
    assert.equal(state.billingCalls, 0);
  }
  status = 400;
  body = { error: { type: "unknown" } };
  await assert.rejects(
    post(state, "checkout/sessions", "same-key", [["customer", "cus_test"]]),
    { code: "provider_unavailable" },
  );
  state.billingCalls = 8;
  const before = calls;
  await assert.rejects(get(state, "prices/price_pack"), {
    code: "payment_pending",
  });
  assert.equal(calls, before);
  state.billingCalls = 0;
  const release = acquireBilling(state, 1n);
  assert.throws(() => acquireBilling(state, 1n), { code: "payment_pending" });
  release();
  assert.equal(state.billingInFlight.size, 0);
  assert.equal(stripeId({ id: "cus_test" }), "cus_test");
  assert.throws(() => stripeId("../customers"));
  assert.equal(
    hostedUrl({ url: "https://checkout.stripe.com/c/pay#test" }, false),
    "https://checkout.stripe.com/c/pay#test",
  );
  for (const url of [
    "https://checkout.stripe.com.evil.test/pay",
    "https://user@checkout.stripe.com/pay",
    "http://checkout.stripe.com/pay",
  ])
    assert.throws(() => hostedUrl({ url }, false));
  status = 200;
  const price = {
    id: "price_pack",
    active: true,
    currency: CATALOG.pack.currency,
    unit_amount: CATALOG.pack.amountCents,
    billing_scheme: "per_unit",
    type: "one_time",
    recurring: null,
    transform_quantity: null,
    metadata: { savvy_catalog_version: CATALOG.pack.version },
  };
  body = price;
  await validatePrice(state, "pack");
  assert.deepEqual(historical(db, "price_pack", "pack"), CATALOG.pack);
  body = { ...price, active: false };
  await assert.rejects(validatePrice(state, "pack"), {
    code: "provider_unavailable",
  });
  // Previously sold allowances survive current provider/catalog changes without refetch.
  const old = { ...CATALOG.pack, hours: 9, version: "old-version" };
  db.prepare(
    "UPDATE catalog_prices SET offer_json=? WHERE price_id='price_pack'",
  ).run(JSON.stringify(old));
  const previousCalls = calls;
  assert.deepEqual(await recoverPrice(state, "price_pack", "pack"), old);
  assert.equal(calls, previousCalls);
  body = price;
  await assert.rejects(validatePrice(state, "pack"), {
    code: "provider_unavailable",
  });
  assert.deepEqual(historical(db, "price_pack", "pack"), old);
  db.prepare(
    "UPDATE catalog_prices SET offer_json=? WHERE price_id='price_pack'",
  ).run(JSON.stringify(CATALOG.pack));
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,stripe_customer_id,created_at_ms) VALUES(1,'issuer','subject','cus_test',0)",
  ).run();
  purchaseFlow = true;
  expectedKey = "savvy-checkout-1-original";
  await assert.rejects(
    checkout(state, 1n, { product: "pack", idempotencyKey: "original" }),
    { code: "provider_unavailable" },
  );
  assert.equal(state.billingInFlight.size, 0);
  const pending = db
    .prepare(
      "SELECT request_key,state,stripe_id FROM checkouts WHERE account_id=1",
    )
    .get();
  assert.deepEqual(pending, {
    request_key: "original",
    state: "pending",
    stripe_id: null,
  });
  createdStatus = 200;
  const recovered = await checkout(state, 1n, {
    product: "pack",
    idempotencyKey: "different-key",
  });
  assert.equal(recovered.attemptId, "original");
  assert.equal(createCalls, 2);
  assert.equal(
    db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM checkouts")
      .get()!.count,
    1n,
  );
  assert.equal(
    (
      await checkout(state, 1n, {
        product: "pack",
        idempotencyKey: "third-key",
      })
    ).attemptId,
    "original",
  );
  assert.equal(createCalls, 2);
  checkoutStatus = "expired";
  await assert.rejects(
    checkout(state, 1n, { product: "pack", idempotencyKey: "fourth-key" }),
    { code: "result_unavailable" },
  );
  assert.equal(
    db.prepare<[], { state: string }>("SELECT state FROM checkouts").get()!
      .state,
    "expired",
  );
  expectedKey = "savvy-checkout-1-fresh";
  await checkout(state, 1n, { product: "pack", idempotencyKey: "fresh" });
  assert.equal(createCalls, 3);
  assert.equal(
    db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM checkouts")
      .get()!.count,
    2n,
  );
  assert.equal(
    db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM allowance_grants",
      )
      .get()!.count,
    0n,
  );
});

test("Stripe signatures authenticate raw bytes with bounded candidates and timestamp tolerance", () => {
  assert.throws(() =>
    verifySignature(
      "secret",
      `t=1000,v1=${"é".repeat(32)}`,
      Buffer.from("{}"),
      1000n,
    ),
  );
  const raw = Buffer.from('{"amount": 2900}');
  const sig = createHmac("sha256", "secret")
    .update("1000.")
    .update(raw)
    .digest("hex");
  verifySignature("secret", `t=1000,v1=${sig}`, raw, 1300n);
  verifySignature("secret", `t=1000,v1=${"0".repeat(64)},v1=${sig}`, raw, 700n);
  assert.throws(() =>
    verifySignature(
      "secret",
      `t=1000,v1=${sig}`,
      Buffer.from('{"amount":2900}'),
      1000n,
    ),
  );
  assert.throws(() =>
    verifySignature("secret", `t=1000,v1=${sig}`, raw, 1301n),
  );
  assert.throws(() =>
    verifySignature(
      "secret",
      `t=1000,${Array(5).fill(`v1=${sig}`).join(",")}`,
      raw,
      1000n,
    ),
  );
  assert.throws(() =>
    verifySignature("secret", `t=1000,v1=${"a".repeat(2100)}`, raw, 1000n),
  );
  assert.throws(() =>
    verifySignature("secret", `t=9223372036854775808,v1=${sig}`, raw, 1000n),
  );
});
