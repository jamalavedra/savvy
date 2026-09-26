import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { CATALOG } from "./catalog.js";
import { ApiError } from "./errors.js";

export const POLICY_VERSION = "managed_v1";
export const MS_PER_HOUR = 3_600_000n;
export const MONTHLY_PERIOD_MS = 30n * 24n * MS_PER_HOUR;
export const SPENDABLE_ORDER = `revoked=0 AND valid_from_ms<=?
  AND (valid_until_ms IS NULL OR valid_until_ms>?)
  ORDER BY (valid_until_ms IS NULL) ASC,valid_until_ms ASC,created_at_ms ASC,id ASC`;

function transactionRequired(db: Db) {
  if (!db.inTransaction)
    throw new Error("Ledger changes require a transaction");
}

export function recordUsage(
  db: Db,
  account: bigint,
  grant: bigint | null,
  session: string | null,
  request: string | null,
  kind: string,
  amountMs: bigint,
  amountBriefs: bigint,
  operationKey: string,
  now: bigint,
) {
  transactionRequired(db);
  return (
    db
      .prepare(
        `INSERT OR IGNORE INTO usage_events
    (account_id,grant_id,session_id,request_id,kind,amount_ms,amount_briefs,operation_key,created_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        account,
        grant,
        session,
        request,
        kind,
        amountMs,
        amountBriefs,
        operationKey,
        now,
      ).changes === 1
  );
}

export function insertGrant(
  db: Db,
  account: bigint,
  origin: string,
  kind: string,
  meetingMs: bigint,
  briefs: bigint,
  from: bigint,
  until: bigint | null,
) {
  transactionRequired(db);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO allowance_grants
    (account_id,origin,kind,meeting_ms_total,briefs_total,valid_from_ms,valid_until_ms,policy_version,created_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      account,
      origin,
      kind,
      meetingMs,
      briefs,
      from,
      until,
      POLICY_VERSION,
      from,
    );
  if (result.changes === 1)
    recordUsage(
      db,
      account,
      BigInt(result.lastInsertRowid),
      null,
      null,
      "grant",
      meetingMs,
      briefs,
      `grant:${origin}`,
      from,
    );
  return result.changes === 1;
}

export function grantFixture(
  db: Db,
  account: bigint,
  kind: string,
  now: bigint,
) {
  transactionRequired(db);
  if (kind !== "monthly" && kind !== "pack")
    throw new ApiError("invalid_request", "unknown fixture grant kind");
  const offer = CATALOG[kind];
  insertGrant(
    db,
    account,
    `fixture:${randomUUID()}`,
    kind,
    BigInt(offer.hours) * MS_PER_HOUR,
    BigInt(offer.briefs),
    now,
    kind === "monthly" ? now + MONTHLY_PERIOD_MS : null,
  );
}

export function reserveAttempt(
  db: Db,
  scope: bigint,
  operation: string,
  now: bigint,
  window: bigint,
  limit: bigint,
) {
  transactionRequired(db);
  const row = db
    .prepare<[bigint, string, bigint], { started_ms: bigint; count: bigint }>(
      "SELECT started_ms,count FROM attempt_counters WHERE scope=? AND operation=? AND window_ms=?",
    )
    .get(scope, operation, window);
  const fresh = !row || now - row.started_ms >= window;
  const start = fresh ? now : row.started_ms;
  const count = fresh ? 0n : row.count;
  if (count >= limit)
    throw new ApiError(
      "rate_limited",
      "operation limit reached",
      max(1n, start + window - now),
    );
  db.prepare("INSERT OR REPLACE INTO attempt_counters VALUES(?,?,?,?,?)").run(
    scope,
    operation,
    window,
    start,
    count + 1n,
  );
}

export function requestState(
  db: Db,
  account: bigint,
  key: string,
): string | undefined {
  return db
    .prepare<[bigint, string, bigint, string], { state: string }>(
      `SELECT state FROM provider_requests WHERE account_id=? AND request_key=?
    UNION ALL SELECT 'canceled' FROM cancellation_tombstones WHERE account_id=? AND request_key=? LIMIT 1`,
    )
    .get(account, key, account, key)?.state;
}

export function reserveBrief(
  db: Db,
  account: bigint,
  key: string,
  now: bigint,
) {
  transactionRequired(db);
  if (requestState(db, account, key) !== undefined)
    throw new ApiError(
      "result_unavailable",
      "request already dispatched or canceled",
    );
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO provider_requests(account_id,request_key,operation,state,created_at_ms) VALUES(?,?,'brief','pending',?)",
    )
    .run(account, key, now);
  if (result.changes === 0)
    throw new ApiError(
      "session_conflict",
      "this brief request was already dispatched",
    );
  const grant = db
    .prepare<[bigint, bigint, bigint], { id: bigint }>(
      `SELECT id FROM allowance_grants WHERE account_id=? AND briefs_total-briefs_used-briefs_reserved>=1 AND ${SPENDABLE_ORDER} LIMIT 1`,
    )
    .get(account, now, now);
  if (!grant)
    throw new ApiError(
      "quota_exhausted",
      "no brief allowance remains; buy an hours pack or wait for renewal",
    );
  db.prepare(
    "UPDATE allowance_grants SET briefs_reserved=briefs_reserved+1 WHERE id=?",
  ).run(grant.id);
  db.prepare(
    "UPDATE provider_requests SET grant_id=?,deadline_ms=? WHERE account_id=? AND request_key=?",
  ).run(grant.id, now + 120_000n, account, key);
}

function reservedBriefGrant(db: Db, account: bigint, key: string) {
  return db
    .prepare<[bigint, string], { grant_id: bigint | null }>(
      "SELECT grant_id FROM provider_requests WHERE account_id=? AND request_key=? AND state='pending'",
    )
    .get(account, key)?.grant_id;
}

export function settleBriefSuccess(
  db: Db,
  account: bigint,
  key: string,
  now: bigint,
) {
  transactionRequired(db);
  const grant = reservedBriefGrant(db, account, key);
  if (grant == null)
    throw new ApiError(
      "result_unavailable",
      "brief canceled before settlement",
    );
  const eligible = db
    .prepare<[bigint], { eligible: bigint }>(
      "SELECT NOT g.revoked AND NOT a.disabled AS eligible FROM allowance_grants g JOIN accounts a ON a.id=g.account_id WHERE g.id=?",
    )
    .get(grant)?.eligible;
  if (!eligible)
    throw new ApiError(
      "quota_exhausted",
      "the reserved purchase is no longer eligible",
    );
  if (
    recordUsage(
      db,
      account,
      grant,
      null,
      key,
      "debit_brief",
      0n,
      1n,
      `brief:${account}:${key}`,
      now,
    )
  )
    db.prepare(
      "UPDATE allowance_grants SET briefs_reserved=briefs_reserved-1,briefs_used=briefs_used+1 WHERE id=?",
    ).run(grant);
  db.prepare(
    "UPDATE provider_requests SET state='succeeded' WHERE account_id=? AND request_key=?",
  ).run(account, key);
}

export function releaseBrief(
  db: Db,
  account: bigint,
  key: string,
  now: bigint,
) {
  transactionRequired(db);
  const grant = reservedBriefGrant(db, account, key);
  if (
    grant != null &&
    recordUsage(
      db,
      account,
      grant,
      null,
      key,
      "release",
      0n,
      1n,
      `brief-release:${account}:${key}`,
      now,
    )
  )
    db.prepare(
      "UPDATE allowance_grants SET briefs_reserved=briefs_reserved-1 WHERE id=?",
    ).run(grant);
  db.prepare(
    "UPDATE provider_requests SET state='failed' WHERE account_id=? AND request_key=? AND state='pending'",
  ).run(account, key);
}

export interface Grant {
  id: bigint;
  account_id: bigint;
  origin: string;
  kind: string;
  meeting_ms_total: bigint;
  meeting_ms_used: bigint;
  meeting_ms_reserved: bigint;
  briefs_total: bigint;
  briefs_used: bigint;
  briefs_reserved: bigint;
  valid_from_ms: bigint;
  valid_until_ms: bigint | null;
  revoked: bigint;
  policy_version: string;
  created_at_ms: bigint;
}

export function max(a: bigint, b: bigint) {
  return a > b ? a : b;
}
export function min(a: bigint, b: bigint) {
  return a < b ? a : b;
}

export function balance(db: Db, account: bigint, now: bigint) {
  const totals = {
    meetingMsAvailable: 0n,
    meetingMsReserved: 0n,
    briefsAvailable: 0n,
    briefsReserved: 0n,
    monthlyMsAvailable: 0n,
    monthlyMsReserved: 0n,
    packMsAvailable: 0n,
    packMsReserved: 0n,
    monthlyBriefsAvailable: 0n,
    packBriefsAvailable: 0n,
    monthlyMsTotal: 0n,
    monthlyMsUsed: 0n,
    periodEndMs: null as bigint | null,
  };
  const rows = db
    .prepare<[bigint, bigint, bigint], Grant>(
      `SELECT * FROM allowance_grants WHERE account_id=? AND ${SPENDABLE_ORDER}`,
    )
    .all(account, now, now);
  for (const g of rows) {
    const ms = max(
      0n,
      g.meeting_ms_total - g.meeting_ms_used - g.meeting_ms_reserved,
    );
    const briefs = max(0n, g.briefs_total - g.briefs_used - g.briefs_reserved);
    totals.meetingMsAvailable += ms;
    totals.meetingMsReserved += g.meeting_ms_reserved;
    totals.briefsAvailable += briefs;
    totals.briefsReserved += g.briefs_reserved;
    if (g.kind === "monthly") {
      totals.monthlyMsAvailable += ms;
      totals.monthlyMsReserved += g.meeting_ms_reserved;
      totals.monthlyBriefsAvailable += briefs;
      totals.monthlyMsTotal += g.meeting_ms_total;
      totals.monthlyMsUsed += g.meeting_ms_used;
      if (g.valid_until_ms !== null)
        totals.periodEndMs =
          totals.periodEndMs === null
            ? g.valid_until_ms
            : max(totals.periodEndMs, g.valid_until_ms);
    } else {
      totals.packMsAvailable += ms;
      totals.packMsReserved += g.meeting_ms_reserved;
      totals.packBriefsAvailable += briefs;
    }
  }
  return totals;
}

export function accountSummary(
  db: Db,
  account: bigint,
  now: bigint,
  billed = true,
) {
  const totals = balance(db, account, now);
  const subscription = db
    .prepare<
      [bigint],
      {
        status: string;
        paid_through_ms: bigint | null;
        cancel_at_period_end: bigint;
      }
    >(
      "SELECT status,paid_through_ms,cancel_at_period_end FROM subscriptions WHERE account_id=? ORDER BY updated_at_ms DESC LIMIT 1",
    )
    .get(account);
  const subject = db
    .prepare<[bigint], { subject: string }>(
      "SELECT subject FROM accounts WHERE id=?",
    )
    .get(account)?.subject;
  if (subject === undefined)
    throw new ApiError("internal", "the service hit an internal error");
  const pending = db
    .prepare<[bigint], { product: string; attemptId: string; status: string }>(
      "SELECT product,request_key AS attemptId,state AS status FROM checkouts WHERE account_id=? AND state IN ('pending','payment_pending')",
    )
    .all(account);
  const latest = db
    .prepare<[bigint], { product: string; attemptId: string; status: string }>(
      "SELECT product,request_key AS attemptId,state AS status FROM checkouts WHERE account_id=? AND state IN ('complete','failed','expired') ORDER BY COALESCE(checked_at_ms,created_at_ms) DESC,rowid DESC LIMIT 1",
    )
    .get(account);
  return {
    catalog: billed ? CATALOG : null,
    pendingPurchases: billed ? pending : [],
    latestConfirmedPurchase: billed ? (latest ?? null) : null,
    allowances: {
      monthly: {
        meetingMsAvailable: totals.monthlyMsAvailable,
        meetingMsReserved: totals.monthlyMsReserved,
        briefsAvailable: totals.monthlyBriefsAvailable,
      },
      pack: {
        meetingMsAvailable: totals.packMsAvailable,
        meetingMsReserved: totals.packMsReserved,
        briefsAvailable: totals.packBriefsAvailable,
      },
    },
    accountIdentity: subject,
    paymentPending: billed && pending.length > 0,
    policyVersion: POLICY_VERSION,
    nowMs: now,
    meetingMsAvailable: totals.meetingMsAvailable,
    meetingMsReserved: totals.meetingMsReserved,
    briefsAvailable: totals.briefsAvailable,
    briefsReserved: totals.briefsReserved,
    monthlyMsTotal: totals.monthlyMsTotal,
    monthlyMsUsed: totals.monthlyMsUsed,
    periodEndMs: totals.periodEndMs,
    subscription: subscription
      ? {
          status: subscription.status,
          paidThroughMs: subscription.paid_through_ms,
          cancelAtPeriodEnd: subscription.cancel_at_period_end !== 0n,
        }
      : null,
    limits: {
      adviceInputTokens: 24_000,
      adviceOutputTokens: 1_024,
      briefInputTokens: 120_000,
      briefOutputTokens: 4_096,
      adviceAttemptsPerHour: 120,
      adviceMinStartGapMs: 5_000,
    },
  };
}
