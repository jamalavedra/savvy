import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openServiceDatabase } from "./db.js";
import { rollbackPreflight } from "./rollback-preflight.js";
import {
  activateTeamPurchases,
  disableTeamPurchases,
  assertFundingCapability,
  setCapability,
} from "./capability.js";

test("activation permanently refuses legacy and checkpoint rollback even before the first seat grant", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "savvy-rollback-"));
  const db = openServiceDatabase(":memory:");
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const candidate = (level: number) => {
    const path = join(directory, `candidate-${level}.json`);
    writeFileSync(path, JSON.stringify({ funding_schema: level }));
    return path;
  };
  const legacy = join(directory, "missing-manifest.json"),
    checkpoint = candidate(1),
    complete = candidate(2);
  assert.equal(rollbackPreflight(db, legacy).requiredFundingSchema, 0);
  assert.equal(rollbackPreflight(db, checkpoint).availableFundingSchema, 1);
  activateTeamPurchases(db, "a".repeat(40), 2, 1n, 2);
  for (const path of [legacy, candidate(0), checkpoint])
    assert.throws(() => rollbackPreflight(db, path), /switch refused/);
  assert.deepEqual(rollbackPreflight(db, complete), {
    requiredFundingSchema: 2,
    availableFundingSchema: 2,
  });
  assert.throws(() => assertFundingCapability(db, 1));
  disableTeamPurchases(db, 2n);
  assert.throws(() => rollbackPreflight(db, checkpoint), /switch refused/);
  assert.equal(
    db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM allowance_grants")
      .get()!.n,
    0n,
  );
  assert.equal(rollbackPreflight(db, complete).requiredFundingSchema, 2);
  writeFileSync(complete, "{}");
  assert.throws(() => rollbackPreflight(db, complete), /Invalid funding/);
});

test("a pending team payment or acquisition flag cannot evade the floor when no grant exists", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "savvy-pending-rollback-"));
  const db = openServiceDatabase(":memory:");
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const candidate = join(directory, "checkpoint.json");
  writeFileSync(candidate, '{"funding_schema":1}');
  db.transaction(() =>
    setCapability(db, "team_purchase_enabled", "1", 1n),
  ).immediate();
  assert.throws(() => rollbackPreflight(db, candidate), /switch refused/);
  disableTeamPurchases(db, 2n);
  db.prepare(
    "INSERT INTO organizations(id,name,created_at_ms) VALUES(1,'Team',0)",
  ).run();
  db.prepare(
    "INSERT INTO organization_checkouts(organization_id,request_key,quantity,price_id,return_url,stripe_idempotency_key,state,created_at_ms,updated_at_ms) VALUES(1,'pending',2,'price','https://example.test/team','key','unknown',0,0)",
  ).run();
  assert.throws(() => rollbackPreflight(db, candidate), /switch refused/);
  assert.equal(
    db
      .prepare<[], { n: bigint }>("SELECT count(*) AS n FROM allowance_grants")
      .get()!.n,
    0n,
  );
});

test("a legacy database is readable without migrations and malformed database requirements fail closed", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  assert.equal(
    rollbackPreflight(db, "/missing/manifest.json").requiredFundingSchema,
    0,
  );
  db.exec(
    "CREATE TABLE service_capabilities(key TEXT PRIMARY KEY,value TEXT); INSERT INTO service_capabilities VALUES('required_funding_schema','not-a-number')",
  );
  assert.throws(
    () => rollbackPreflight(db, "/missing/manifest.json"),
    /Invalid database/,
  );
});
