import assert from "node:assert/strict";
import { test } from "node:test";
import { noteError, persistErrorsIn, recentErrors } from "./recent-errors.js";

test("error counts survive a new isolate through the store and expire after five minutes", () => {
  const now = 1_800_000_000_000;
  const kv = new Map<string, unknown>([
    [
      "recent-errors:billing_retries_5m",
      [now - 400_000, now - 60_000, now - 1_000],
    ],
  ]);
  persistErrorsIn({
    get: (key) => kv.get(key),
    put: (key, value) => kv.set(key, value),
  });
  assert.equal(recentErrors(now).billing_retries_5m, 2);
  noteError("reconcile_failures_5m", now);
  assert.deepEqual(kv.get("recent-errors:reconcile_failures_5m"), [now]);
  noteError("billing_retries_5m", now);
  assert.deepEqual(kv.get("recent-errors:billing_retries_5m"), [
    now - 60_000,
    now - 1_000,
    now,
  ]);
});
