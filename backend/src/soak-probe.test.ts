import assert from "node:assert/strict";
import { test } from "node:test";
import { problems } from "./soak-probe.js";

const now = 10_000_000;
const healthy = { alarmAtMs: now + 30_000, lastAlarmAtMs: now - 30_000 };

test("a ready object with a recent alarm and no failures is healthy", () => {
  assert.deepEqual(problems(200, { ...healthy, failures: [] }, now), []);
});

test("the soak probe flags readiness, invariants and alarm lag", () => {
  assert.deepEqual(
    problems(503, { ...healthy, failures: ["negative_allowances"] }, now),
    ["ready_503", "negative_allowances"],
  );
  assert.deepEqual(
    problems(
      200,
      { alarmAtMs: now - 180_001, lastAlarmAtMs: now - 180_001, failures: [] },
      now,
    ),
    ["alarm_overdue", "alarm_lag"],
  );
  assert.deepEqual(
    problems(
      200,
      { alarmAtMs: now - 180_000, lastAlarmAtMs: now - 180_000, failures: [] },
      now,
    ),
    [],
  );
  assert.deepEqual(
    problems(200, { alarmAtMs: null, lastAlarmAtMs: null, failures: [] }, now),
    ["alarm_unset", "alarm_lag"],
  );
  assert.deepEqual(problems("unreachable:x", "401", now), [
    "ready_unreachable:x",
    "status_401",
  ]);
});
