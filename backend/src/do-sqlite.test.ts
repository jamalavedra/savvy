import assert from "node:assert/strict";
import test from "node:test";
import { createAuth } from "./auth.js";
import { openServiceDatabase, type Db } from "./db.js";
import { migrate } from "./migrate.js";

// DoSqlite turns every integral Number into a BigInt on the service handle, so a
// REAL value of 3.0 would come back as 3n. That holds only while no column can
// store a non-integer number.
const NON_INTEGER = /REAL|FLOA|DOUB|NUMERIC|DECIMAL/i;

function nonIntegerColumns(db: Db): string[] {
  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  return tables.flatMap(({ name }) =>
    db
      .prepare<[string], { name: string; type: string }>(
        "SELECT name, type FROM pragma_table_info(?)",
      )
      .all(name)
      .filter((column) => NON_INTEGER.test(column.type))
      .map((column) => `${name}.${column.name} ${column.type}`),
  );
}

test("no service or Better Auth column is declared with a non-integer numeric type", async (t) => {
  const service = openServiceDatabase(":memory:");
  t.after(() => service.close());
  assert.deepEqual(nonIntegerColumns(service), []);

  const instance = createAuth({
    SAVVY_AUTH_DATABASE: ":memory:",
    BETTER_AUTH_URL: "http://127.0.0.1:8788",
    BETTER_AUTH_SECRET: "schema-guard-secret-schema-guard-0123456789",
  });
  t.after(() => instance.db.close());
  await migrate(instance);
  const authTables = instance.db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='oauthRefreshToken'")
    .get();
  assert.ok(authTables, "Better Auth migrations created its tables");
  assert.deepEqual(nonIntegerColumns(instance.db), []);

  service.exec("CREATE TABLE guard_probe(amount REAL)");
  assert.deepEqual(nonIntegerColumns(service), ["guard_probe.amount REAL"]);
});
