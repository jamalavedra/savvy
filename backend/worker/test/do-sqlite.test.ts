import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestHarness } from "wrangler";

const server = createTestHarness({
  workers: [{ configPath: new URL("./wrangler.jsonc", import.meta.url) }],
});
before(() => server.listen());
after(() => server.close());

const scenarios = {
  integers:
    "integers round-trip as BigInt or Number per handle, and beyond ±2^53 throw",
  "nested-inner-throw":
    "a caught throw in a nested transaction keeps the outer writes only",
  "outer-throw": "an outer throw rolls back the outer and nested writes",
  pragmas:
    "supported pragmas answer or are ignored, and the rest throw clearly",
  "migrate-twice": "migrateService runs twice and leaves the same schema",
  ledger: "reserve, release and settle leave the expected ledger rows",
  "auth-rollback":
    "a Better Auth transaction that fails mid-flow leaves no partial row",
  concurrency:
    "an open auth transaction blocks a concurrent ledger write, which survives the rollback",
};

for (const [path, name] of Object.entries(scenarios))
  test(name, async () => {
    const response = await server.fetch(`/${path}`);
    assert.equal(response.status, 200, await response.text());
  });
