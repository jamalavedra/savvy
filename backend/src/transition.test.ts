import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { openServiceDatabase } from "./db.js";
import { configuration } from "./config.js";
import { ServiceState } from "./state.js";
import { setCapability } from "./capability.js";
import { createOrganization } from "./org.js";
import { bindCustomer } from "./stripe.js";
import { recordOrganizationCheckout, type Checkout } from "./org-stripe.js";
import {
  LIFECYCLES,
  states,
  transition,
  type Lifecycle,
  type StateOf,
} from "./transition.js";

function fixture(t: TestContext) {
  const db = openServiceDatabase(":memory:");
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','a',0)",
  ).run();
  db.prepare(
    "INSERT INTO checkouts(account_id,request_key,product,state,created_at_ms) VALUES(1,'key','pack','pending',0)",
  ).run();
  const state = () =>
    db
      .prepare<[], { state: string; stripe_id: string | null }>(
        "SELECT state,stripe_id FROM checkouts WHERE request_key='key'",
      )
      .get()!;
  return { db, state };
}

test("transition updates only rows in a listed from-state and reports whether one changed", (t) => {
  const h = fixture(t);
  const key = { where: "account_id=? AND request_key=?", params: [1n, "key"] };
  assert.equal(
    transition(h.db, "checkouts", ["pending"], "payment_pending", key),
    true,
  );
  assert.deepEqual(h.state(), { state: "payment_pending", stripe_id: null });
  assert.equal(
    transition(h.db, "checkouts", ["pending"], "complete", key),
    false,
  );
  assert.deepEqual(h.state(), { state: "payment_pending", stripe_id: null });
  assert.equal(
    transition(h.db, "checkouts", ["payment_pending"], "payment_pending", {
      ...key,
      set: "stripe_id=?",
      params: ["cs_1", ...key.params],
    }),
    true,
    "a row may be rewritten in its current state",
  );
  assert.deepEqual(h.state(), { state: "payment_pending", stripe_id: "cs_1" });
  assert.equal(
    transition(h.db, "checkouts", ["pending", "payment_pending"], "complete", {
      ...key,
      where: "account_id=? AND request_key=? AND stripe_id=?",
      params: [...key.params, "cs_other"],
    }),
    false,
    "the caller's where clause still applies",
  );
  assert.equal(h.state().state, "payment_pending");
});

test("transition rejects edges outside the lifecycle table before touching the row", (t) => {
  const h = fixture(t);
  const key = { where: "request_key=?", params: ["key"] };
  assert.throws(
    () =>
      transition(h.db, "checkouts", ["pending", "complete"], "pending", key),
    /Illegal checkouts transition complete -> pending/,
  );
  assert.throws(
    () => transition(h.db, "checkouts", [], "complete", key),
    /needs a from-state/,
  );
  assert.throws(
    () =>
      transition(h.db, "checkouts", ["pending"], "bogus" as "complete", key),
    /Unknown checkouts state "bogus"/,
  );
  assert.throws(
    () =>
      transition(h.db, "checkouts", ["bogus" as "pending"], "complete", key),
    /Illegal checkouts transition bogus -> complete/,
  );
  assert.deepEqual(h.state(), { state: "pending", stripe_id: null });
});

test("every lifecycle names known states and its terminal states have no way out", (t) => {
  const h = fixture(t);
  const terminal: Record<Lifecycle, string[]> = {
    checkouts: ["complete", "expired"],
    organization_checkouts: ["complete", "expired"],
    organization_quantity_changes: ["applied", "failed"],
    managed_sessions: ["stopped"],
    provider_requests: ["succeeded", "failed"],
    billing_events: ["processed", "ignored", "rejected"],
  };
  for (const table of Object.keys(LIFECYCLES) as Lifecycle[]) {
    const known: string[] = states(table);
    const edges = LIFECYCLES[table].edges as Record<string, readonly string[]>;
    for (const [from, targets] of Object.entries(edges)) {
      for (const to of targets) assert.ok(known.includes(to), `${table} ${to}`);
      assert.ok(!targets.includes(from), `${table} ${from} lists itself`);
    }
    assert.deepEqual(
      known.filter((state) => edges[state]!.length === 0),
      terminal[table],
    );
    for (const from of terminal[table])
      for (const to of known)
        if (to !== from)
          assert.throws(
            () =>
              transition(
                h.db,
                table,
                [from as StateOf<typeof table>],
                to as StateOf<typeof table>,
                { where: "1", params: [] },
              ),
            new RegExp(`Illegal ${table} transition ${from} -> ${to}`),
          );
  }
  // Proof of payment is the one way back from failed.
  assert.deepEqual(LIFECYCLES.checkouts.edges.failed, ["complete"]);
  assert.deepEqual(LIFECYCLES.organization_checkouts.edges.failed, [
    "complete",
  ]);
});

test("no state write for a lifecycle table bypasses the transition helper", () => {
  const tables = Object.keys(LIFECYCLES).join("|");
  const raw = new RegExp(
    `UPDATE\\s+(${tables})\\s+SET\\s+(?:(?!WHERE)[^"'\`])*?\\b(state|status)\\s*=`,
  );
  const sources = readdirSync(new URL(".", import.meta.url))
    .filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        !name.endsWith(".check.ts") &&
        name !== "transition.ts",
    )
    .sort();
  assert.ok(sources.includes("stripe.ts"));
  for (const name of sources) {
    const text = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.equal(
      raw.exec(text)?.[0],
      undefined,
      `${name} writes state directly`,
    );
  }
});

test("a team checkout already awaiting payment does not regress when a stale open session is recorded", (t) => {
  const db = openServiceDatabase(":memory:");
  t.after(() => db.close());
  const now = 1_000_000n;
  const tx = <T>(fn: () => T) => db.transaction(fn).immediate();
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','owner',0)",
  ).run();
  tx(() => setCapability(db, "team_purchase_enabled", "1", now));
  const org = tx(() => createOrganization(db, 1n, "Team", now));
  tx(() => bindCustomer(db, "organization", org, "cus_team"));
  db.prepare(
    "INSERT INTO organization_checkouts(organization_id,request_key,quantity,price_id,return_url,stripe_idempotency_key,stripe_session_id,stripe_subscription_id,state,created_at_ms,updated_at_ms) VALUES(?,'team',2,'price_monthly','https://savvy.test/team','team-key','cs_team','sub_team','payment_pending',?,?)",
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
  const row = db
    .prepare<[bigint], Checkout>(
      "SELECT * FROM organization_checkouts WHERE organization_id=?",
    )
    .get(org)!;
  const session = (status: string) => ({
    id: "cs_team",
    status,
    payment_status: "unpaid",
    customer: "cus_team",
    mode: "subscription",
    metadata: { savvy_org: org.toString(), savvy_key: "team" },
    line_items: { data: [{ price: "price_monthly", quantity: 2 }] },
  });
  assert.deepEqual(
    recordOrganizationCheckout(state, row, "cus_team", session("open")),
    { status: "pending", attemptId: "team" },
  );
  assert.equal(
    db
      .prepare<[bigint], { state: string }>(
        "SELECT state FROM organization_checkouts WHERE id=?",
      )
      .get(row.id)!.state,
    "payment_pending",
  );
  assert.deepEqual(
    recordOrganizationCheckout(state, row, "cus_team", session("expired")),
    { status: "expired", attemptId: "team" },
  );
  assert.equal(
    db
      .prepare<[bigint], { state: string }>(
        "SELECT state FROM organization_checkouts WHERE id=?",
      )
      .get(row.id)!.state,
    "expired",
  );
});
