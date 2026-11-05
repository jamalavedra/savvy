import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { migrateService, openServiceDatabase, type Db } from "./db.js";
import {
  LIFECYCLES,
  PAUSE_REASONS,
  states,
  type Lifecycle,
} from "./transition.js";

// The lifecycle tables as an earlier release created them: no CHECK constraints
// and without the columns later releases add through ALTER TABLE.
const LEGACY = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, stripe_customer_id TEXT UNIQUE,
  disabled INTEGER NOT NULL DEFAULT 0, terms_version TEXT, created_at_ms INTEGER NOT NULL, UNIQUE (issuer, subject)
);
CREATE TABLE organizations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, stripe_customer_id TEXT UNIQUE, created_at_ms INTEGER NOT NULL
);
CREATE TABLE allowance_grants (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts (id), origin TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, meeting_ms_total INTEGER NOT NULL, meeting_ms_used INTEGER NOT NULL DEFAULT 0,
  meeting_ms_reserved INTEGER NOT NULL DEFAULT 0, briefs_total INTEGER NOT NULL, briefs_used INTEGER NOT NULL DEFAULT 0,
  briefs_reserved INTEGER NOT NULL DEFAULT 0, valid_from_ms INTEGER NOT NULL, valid_until_ms INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0, policy_version TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE TABLE managed_sessions (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts (id), local_session_id TEXT NOT NULL,
  state TEXT NOT NULL, lease_version INTEGER NOT NULL DEFAULT 0, lease_expires_ms INTEGER,
  reserved_ms INTEGER NOT NULL DEFAULT 0, settled_ms INTEGER NOT NULL DEFAULT 0, billable_since_ms INTEGER,
  interruption TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  UNIQUE (account_id, local_session_id)
);
CREATE TABLE session_reservations (
  session_id INTEGER NOT NULL REFERENCES managed_sessions(id), grant_id INTEGER NOT NULL REFERENCES allowance_grants(id),
  amount_ms INTEGER NOT NULL CHECK(amount_ms >= 0), PRIMARY KEY(session_id, grant_id)
);
CREATE TABLE provider_requests (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts (id), request_key TEXT NOT NULL,
  operation TEXT NOT NULL, state TEXT NOT NULL, grant_id INTEGER, vendor_request_id TEXT, input_tokens INTEGER,
  output_tokens INTEGER, cost_microdollars INTEGER, deadline_ms INTEGER, created_at_ms INTEGER NOT NULL,
  UNIQUE (account_id, request_key)
);
CREATE TABLE checkouts (
  account_id INTEGER NOT NULL REFERENCES accounts(id), request_key TEXT NOT NULL, product TEXT NOT NULL,
  state TEXT NOT NULL, stripe_id TEXT UNIQUE, PRIMARY KEY(account_id,request_key)
);
CREATE TABLE billing_events (
  id INTEGER PRIMARY KEY, stripe_event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, status TEXT NOT NULL,
  related_ids TEXT, created_at_ms INTEGER NOT NULL
);
CREATE TABLE organization_checkouts (
  id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id),
  request_key TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 50),
  price_id TEXT NOT NULL, return_url TEXT NOT NULL, stripe_idempotency_key TEXT NOT NULL UNIQUE,
  stripe_session_id TEXT UNIQUE, stripe_subscription_id TEXT, state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, UNIQUE(organization_id,request_key)
);
CREATE UNIQUE INDEX organization_one_pending_checkout
  ON organization_checkouts(organization_id) WHERE state IN ('pending','payment_pending','unknown');
CREATE TABLE organization_quantity_changes (
  id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id),
  request_key TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 50),
  retire_seat_ids TEXT NOT NULL, stripe_idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, UNIQUE(organization_id,request_key)
);
CREATE UNIQUE INDEX organization_one_pending_quantity_change
  ON organization_quantity_changes(organization_id) WHERE state IN ('pending','unknown');
INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'issuer','a',0);
INSERT INTO organizations(id,name,created_at_ms) VALUES(1,'Team',0);
INSERT INTO allowance_grants(id,account_id,origin,kind,meeting_ms_total,briefs_total,valid_from_ms,policy_version,created_at_ms)
  VALUES(7,1,'origin','pack',1000,1,0,'v1',0);
INSERT INTO managed_sessions(id,account_id,local_session_id,state,interruption,created_at_ms,updated_at_ms)
  VALUES(3,1,'meeting','paused','resume',0,0),(4,1,'older','stopped',NULL,0,0);
INSERT INTO session_reservations VALUES(3,7,500);
INSERT INTO provider_requests(account_id,request_key,operation,state,created_at_ms) VALUES(1,'brief','brief','succeeded',0);
INSERT INTO checkouts VALUES(1,'second','pack','complete','cs_2'),(1,'first','monthly','failed','cs_1');
INSERT INTO billing_events(stripe_event_id,event_type,status,created_at_ms) VALUES('evt_1','invoice.paid','processed',0);
INSERT INTO organization_checkouts(organization_id,request_key,quantity,price_id,return_url,stripe_idempotency_key,state,created_at_ms,updated_at_ms)
  VALUES(1,'team',2,'price','https://example.test/team','key','unknown',0,0);
INSERT INTO organization_quantity_changes(organization_id,request_key,quantity,retire_seat_ids,stripe_idempotency_key,state,created_at_ms)
  VALUES(1,'grow',3,'[]','qkey','applied',0);
`;

function legacyDatabase(): Db {
  const db = new Database(":memory:");
  db.defaultSafeIntegers(true);
  db.pragma("foreign_keys = ON");
  db.exec(LEGACY);
  return db;
}
function layout(db: Db, table: string) {
  const indexes = db.pragma(`index_list('${table}')`) as { name: string }[];
  return {
    columns: db.pragma(`table_info('${table}')`),
    foreignKeys: db.pragma(`foreign_key_list('${table}')`),
    indexes: indexes.map((index) => ({
      ...index,
      columns: db.pragma(`index_info('${index.name}')`),
    })),
  };
}
function definitions(db: Db) {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
    )
    .all();
}
function allowedValues(db: Db, table: string, column: string) {
  const { sql } = db
    .prepare<[string], { sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(table)!;
  const match = new RegExp(`CHECK\\(${column} IN \\(([^)]*)\\)\\)`).exec(sql);
  assert.ok(match, `${table}.${column} has no CHECK constraint`);
  return match[1]!.split(",").map((value) => value.slice(1, -1));
}

test("lifecycle tables from an earlier release are rebuilt with CHECK constraints, keeping rows, indexes and foreign keys", (t) => {
  const db = legacyDatabase();
  const fresh = openServiceDatabase(":memory:");
  t.after(() => {
    db.close();
    fresh.close();
  });
  migrateService(db);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1n);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  for (const table of Object.keys(LIFECYCLES) as Lifecycle[]) {
    assert.deepEqual(
      allowedValues(db, table, LIFECYCLES[table].column).sort(),
      [...states(table)].sort(),
      table,
    );
    assert.deepEqual(layout(db, table), layout(fresh, table), table);
  }
  assert.deepEqual(
    allowedValues(db, "managed_sessions", "pause_reason").sort(),
    [...PAUSE_REASONS].sort(),
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT s.id,s.state,s.interruption,s.pause_reason,s.funding_scope,r.amount_ms FROM managed_sessions s LEFT JOIN session_reservations r ON r.session_id=s.id ORDER BY s.id",
      )
      .all(),
    [
      {
        id: 3n,
        state: "paused",
        interruption: "resume",
        pause_reason: null,
        funding_scope: "personal",
        amount_ms: 500n,
      },
      {
        id: 4n,
        state: "stopped",
        interruption: null,
        pause_reason: null,
        funding_scope: "personal",
        amount_ms: null,
      },
    ],
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT request_key,state,created_at_ms FROM checkouts ORDER BY rowid",
      )
      .all(),
    [
      { request_key: "second", state: "complete", created_at_ms: 0n },
      { request_key: "first", state: "failed", created_at_ms: 0n },
    ],
    "copying in rowid order keeps the tiebreak the latest-purchase query uses",
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT (SELECT count(*) FROM provider_requests WHERE state='succeeded') AS requests,(SELECT count(*) FROM billing_events WHERE status='processed') AS events,(SELECT state FROM organization_checkouts) AS checkout,(SELECT state FROM organization_quantity_changes) AS change,(SELECT previous_retire_seat_ids FROM organization_quantity_changes) AS previous",
      )
      .get(),
    {
      requests: 1n,
      events: 1n,
      checkout: "unknown",
      change: "applied",
      previous: "[]",
    },
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO organization_checkouts(organization_id,request_key,quantity,price_id,return_url,stripe_idempotency_key,state,created_at_ms,updated_at_ms) VALUES(1,'again',2,'price','https://example.test/team','key2','pending',0,0)",
        )
        .run(),
    /organization_one_pending_checkout|UNIQUE/,
    "the partial unique index is recreated",
  );
  for (const [table, column, value] of [
    ["checkouts", "state", "bogus"],
    ["managed_sessions", "pause_reason", "nap"],
  ])
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE ${table} SET ${column}=? WHERE rowid=(SELECT min(rowid) FROM ${table})`,
          )
          .run(value),
      /CHECK constraint failed/,
    );
  const settled = definitions(db);
  migrateService(db);
  assert.deepEqual(definitions(db), settled, "a second run changes nothing");
});

test("the rebuild refuses a database holding a state outside the allowed set and leaves it untouched", (t) => {
  const db = legacyDatabase();
  t.after(() => db.close());
  db.exec("ALTER TABLE managed_sessions ADD COLUMN pause_reason TEXT");
  db.prepare(
    "UPDATE checkouts SET state='bogus' WHERE request_key='first'",
  ).run();
  const before = definitions(db);
  assert.throws(
    () => migrateService(db),
    /checkouts\.state holds "bogus", outside the allowed set/,
  );
  assert.deepEqual(definitions(db), before, "the whole migration rolled back");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1n);
  db.prepare(
    "UPDATE checkouts SET state='failed' WHERE request_key='first'",
  ).run();
  db.prepare("UPDATE managed_sessions SET pause_reason='nap' WHERE id=3").run();
  assert.throws(
    () => migrateService(db),
    /managed_sessions\.pause_reason holds "nap"/,
  );
  assert.deepEqual(definitions(db), before);
  db.prepare(
    "UPDATE managed_sessions SET pause_reason='user' WHERE id=3",
  ).run();
  db.exec("BEGIN");
  assert.throws(() => migrateService(db), /outside a transaction/);
  db.exec("ROLLBACK");
  migrateService(db);
  assert.deepEqual(
    db.prepare("SELECT pause_reason FROM managed_sessions WHERE id=3").get(),
    { pause_reason: "user" },
  );
});
