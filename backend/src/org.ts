import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import type { ServiceState } from "./state.js";
import { ApiError } from "./errors.js";
import {
  insertGrant,
  recordUsage,
  releaseBrief,
  max,
  type Grant,
} from "./billing.js";
import { finishInterval, type SessionRow } from "./sessions.js";
import {
  assertFunding,
  PERSONAL,
  type FundingChoice,
  type FundingContext,
} from "./funding.js";
import { teamPurchasesEnabled } from "./capability.js";
import { CATALOG } from "./catalog.js";

function transactionRequired(db: Db) {
  if (!db.inTransaction)
    throw new Error("Organization writes require a transaction");
}
function requireAcquisition(db: Db) {
  if (!teamPurchasesEnabled(db))
    throw new ApiError(
      "team_purchase_disabled",
      "new team purchases and invitations are currently unavailable",
    );
}
function invalid(message: string): never {
  throw new ApiError("invalid_request", message);
}
function denied(): never {
  throw new ApiError(
    "invalid_request",
    "organization action is not permitted",
    undefined,
    403,
  );
}
export function requireOwner(db: Db, actor: bigint, org: bigint) {
  if (
    !db
      .prepare(
        "SELECT 1 FROM organization_members WHERE organization_id=? AND account_id=? AND role='owner'",
      )
      .get(org, actor)
  )
    denied();
}
export function normalizeEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    invalid("a valid invitation email is required");
  return normalized;
}
export function createOrganization(
  db: Db,
  actor: bigint,
  name: string,
  now: bigint,
  email?: string,
) {
  transactionRequired(db);
  requireAcquisition(db);
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120)
    invalid("organization name must be 1..120 characters");
  if (
    db
      .prepare("SELECT 1 FROM organization_members WHERE account_id=?")
      .get(actor)
  )
    invalid("you already belong to an organization");
  const id = BigInt(
    db
      .prepare("INSERT INTO organizations(name,created_at_ms) VALUES(?,?)")
      .run(trimmed, now).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO organization_members(organization_id,account_id,role,display_email,created_at_ms) VALUES(?,?,'owner',?,?)",
  ).run(id, actor, email ? normalizeEmail(email) : null, now);
  return id;
}
const INVITE_LIFETIME = 7n * 24n * 3_600_000n;
function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function inviteMember(
  db: Db,
  actor: bigint,
  org: bigint,
  email: string,
  assignSeat: boolean,
  now: bigint,
) {
  transactionRequired(db);
  requireOwner(db, actor, org);
  requireAcquisition(db);
  const normalized = normalizeEmail(email);
  const pending = db
    .prepare<[bigint, bigint], { n: bigint }>(
      "SELECT count(*) AS n FROM organization_invitations WHERE organization_id=? AND revoked=0 AND accepted_at_ms IS NULL AND expires_ms>?",
    )
    .get(org, now)!.n;
  if (pending >= 50n)
    throw new ApiError(
      "rate_limited",
      "at most 50 open invitations are allowed",
    );
  const token = randomBytes(32).toString("base64url");
  const id = BigInt(
    db
      .prepare(
        "INSERT INTO organization_invitations(organization_id,email_normalized,token_hash,assign_seat,expires_ms,delivery_state,created_at_ms) VALUES(?,?,?,?,?,'pending',?)",
      )
      .run(
        org,
        normalized,
        hashToken(token),
        assignSeat ? 1 : 0,
        now + INVITE_LIFETIME,
        now,
      ).lastInsertRowid,
  );
  return { id: id.toString(), token, email: normalized };
}
export function resendInvitation(
  db: Db,
  actor: bigint,
  org: bigint,
  id: bigint,
  now: bigint,
) {
  transactionRequired(db);
  requireOwner(db, actor, org);
  requireAcquisition(db);
  const token = randomBytes(32).toString("base64url");
  const updated = db
    .prepare(
      "UPDATE organization_invitations SET token_hash=?,expires_ms=?,delivery_state='pending' WHERE id=? AND organization_id=? AND revoked=0 AND accepted_at_ms IS NULL",
    )
    .run(hashToken(token), now + INVITE_LIFETIME, id, org);
  if (updated.changes !== 1) invalid("invitation is no longer open");
  const row = db
    .prepare<[bigint], { email_normalized: string }>(
      "SELECT email_normalized FROM organization_invitations WHERE id=?",
    )
    .get(id)!;
  return { id: id.toString(), token, email: row.email_normalized };
}
export function revokeInvitation(
  db: Db,
  actor: bigint,
  org: bigint,
  id: bigint,
) {
  transactionRequired(db);
  requireOwner(db, actor, org);
  if (
    db
      .prepare(
        "UPDATE organization_invitations SET revoked=1 WHERE id=? AND organization_id=? AND accepted_at_ms IS NULL",
      )
      .run(id, org).changes !== 1
  )
    invalid("invitation is no longer open");
}
export interface SeatPeriod {
  id: bigint;
  organization_id: bigint;
  seat_id: bigint;
  invoice_id: string;
  starts_ms: bigint;
  ends_ms: bigint;
  budget_ms: bigint;
  budget_briefs: bigint;
  financial_status: string;
}
export interface Assignment {
  id: bigint;
  seat_id: bigint;
  account_id: bigint;
  ended_at_ms: bigint | null;
}

export function assertSeatConservation(db: Db, period: SeatPeriod) {
  const totals = db
    .prepare<[bigint], { ms: bigint; briefs: bigint; live: bigint }>(
      `SELECT COALESCE(sum(meeting_ms_used+meeting_ms_reserved+CASE WHEN revoked=0 THEN meeting_ms_total-meeting_ms_used-meeting_ms_reserved ELSE 0 END),0) AS ms,
      COALESCE(sum(briefs_used+briefs_reserved+CASE WHEN revoked=0 THEN briefs_total-briefs_used-briefs_reserved ELSE 0 END),0) AS briefs,
      COALESCE(sum(CASE WHEN revoked=0 THEN 1 ELSE 0 END),0) AS live FROM allowance_grants WHERE seat_period_id=?`,
    )
    .get(period.id)!;
  if (
    totals.ms < 0n ||
    totals.briefs < 0n ||
    totals.ms > period.budget_ms ||
    totals.briefs > period.budget_briefs ||
    totals.live > 1n
  )
    throw new Error("Seat-period allowance conservation failed");
  if (
    db
      .prepare(
        "SELECT 1 FROM allowance_grants WHERE seat_period_id=? AND (meeting_ms_used<0 OR meeting_ms_reserved<0 OR meeting_ms_used+meeting_ms_reserved>meeting_ms_total OR briefs_used<0 OR briefs_reserved<0 OR briefs_used+briefs_reserved>briefs_total)",
      )
      .get(period.id)
  )
    throw new Error("Invalid seat grant balance");
}
export function grantForAssignment(
  db: Db,
  assignment: Assignment,
  period: SeatPeriod,
  now: bigint,
) {
  transactionRequired(db);
  const storedAssignment = db
    .prepare<[bigint], Assignment>("SELECT * FROM seat_assignments WHERE id=?")
    .get(assignment.id);
  const storedPeriod = db
    .prepare<[bigint], SeatPeriod>("SELECT * FROM seat_periods WHERE id=?")
    .get(period.id);
  if (
    !storedAssignment ||
    !storedPeriod ||
    storedAssignment.account_id !== assignment.account_id ||
    storedAssignment.seat_id !== storedPeriod.seat_id
  )
    invalid("assignment does not belong to this seat period");
  assignment = storedAssignment;
  period = storedPeriod;
  // Disabling identity prevents spending, not recording an already-paid entitlement.
  if (
    !db
      .prepare(
        `SELECT 1 FROM seat_assignments a JOIN seats s ON s.id=a.seat_id
    JOIN organization_members m ON m.organization_id=s.organization_id AND m.account_id=a.account_id
    WHERE a.id=? AND a.account_id=? AND a.ended_at_ms IS NULL AND s.organization_id=? AND s.status<>'retired'`,
      )
      .get(assignment.id, assignment.account_id, period.organization_id)
  )
    throw new ApiError(
      "no_seat",
      "the assignment is not eligible for this paid seat period",
    );
  if (
    assignment.seat_id !== period.seat_id ||
    period.financial_status !== "paid" ||
    now < period.starts_ms ||
    now >= period.ends_ms
  )
    invalid("seat period is not currently eligible");
  const origin = `seat-assignment:${assignment.id}:period:${period.id}`;
  const existing = db
    .prepare<[string], Grant>("SELECT * FROM allowance_grants WHERE origin=?")
    .get(origin);
  if (existing) {
    assertSeatConservation(db, period);
    return existing.id;
  }
  const spent = db
    .prepare<[bigint], { ms: bigint; briefs: bigint }>(
      "SELECT COALESCE(sum(meeting_ms_used+meeting_ms_reserved),0) AS ms,COALESCE(sum(briefs_used+briefs_reserved),0) AS briefs FROM allowance_grants WHERE seat_period_id=?",
    )
    .get(period.id)!;
  const ms = period.budget_ms - spent.ms,
    briefs = period.budget_briefs - spent.briefs;
  if (ms < 0n || briefs < 0n) throw new Error("Seat period is overspent");
  insertGrant(
    db,
    assignment.account_id,
    origin,
    "seat",
    ms,
    briefs,
    max(period.starts_ms, now),
    period.ends_ms,
  );
  db.prepare(
    "UPDATE allowance_grants SET seat_period_id=?,seat_assignment_id=? WHERE origin=?",
  ).run(period.id, assignment.id, origin);
  assertSeatConservation(db, period);
  return db
    .prepare<[string], { id: bigint }>(
      "SELECT id FROM allowance_grants WHERE origin=?",
    )
    .get(origin)!.id;
}
export function assignableSeats(db: Db, org: bigint, now: bigint) {
  return db
    .prepare<[bigint, bigint, bigint], { id: bigint; seat_number: bigint }>(
      `SELECT s.id,s.seat_number FROM seats s WHERE s.organization_id=? AND s.status='active'
     AND NOT EXISTS(SELECT 1 FROM seat_assignments a WHERE a.seat_id=s.id AND a.ended_at_ms IS NULL)
     AND EXISTS(SELECT 1 FROM seat_periods p WHERE p.seat_id=s.id AND p.organization_id=s.organization_id AND p.financial_status='paid' AND p.starts_ms<=? AND p.ends_ms>?) ORDER BY s.seat_number`,
    )
    .all(org, now, now);
}
function assignToMember(
  db: Db,
  org: bigint,
  account: bigint,
  now: bigint,
  seatId?: bigint,
) {
  transactionRequired(db);
  if (
    !db
      .prepare(
        "SELECT 1 FROM organization_members m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.account_id=? AND a.disabled=0",
      )
      .get(org, account)
  )
    denied();
  if (
    db
      .prepare(
        "SELECT 1 FROM seat_assignments WHERE account_id=? AND ended_at_ms IS NULL",
      )
      .get(account)
  )
    invalid("member already has a seat");
  const free = assignableSeats(db, org, now);
  const seat =
    seatId === undefined ? free[0] : free.find((s) => s.id === seatId);
  if (!seat) throw new ApiError("quota_exhausted", "no free paid seat");
  const overlapping = db
    .prepare<[bigint, bigint, bigint], SeatPeriod>(
      "SELECT * FROM seat_periods WHERE seat_id=? AND financial_status='paid' AND starts_ms<=? AND ends_ms>? ORDER BY starts_ms DESC",
    )
    .all(seat.id, now, now);
  if (overlapping.length !== 1)
    throw new Error("Expected one paid seat period");
  const id = BigInt(
    db
      .prepare(
        "INSERT INTO seat_assignments(seat_id,account_id,assigned_at_ms) VALUES(?,?,?)",
      )
      .run(seat.id, account, now).lastInsertRowid,
  );
  grantForAssignment(
    db,
    { id, account_id: account, seat_id: seat.id, ended_at_ms: null },
    overlapping[0],
    now,
  );
  return { assignmentId: id.toString(), seatId: seat.id.toString() };
}
export function assignSeat(
  db: Db,
  actor: bigint,
  org: bigint,
  account: bigint,
  now: bigint,
  seatId?: bigint,
) {
  transactionRequired(db);
  requireOwner(db, actor, org);
  return assignToMember(db, org, account, now, seatId);
}
export function acceptInvitation(
  db: Db,
  actor: bigint,
  verifiedEmail: string,
  token: string,
  now: bigint,
) {
  transactionRequired(db);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    invalid("invitation is invalid or expired");
  const invite = db
    .prepare<
      [string],
      {
        id: bigint;
        organization_id: bigint;
        email_normalized: string;
        assign_seat: bigint;
        expires_ms: bigint;
        revoked: bigint;
        accepted_at_ms: bigint | null;
      }
    >("SELECT * FROM organization_invitations WHERE token_hash=?")
    .get(hashToken(token));
  if (
    !invite ||
    invite.revoked ||
    invite.accepted_at_ms !== null ||
    invite.expires_ms <= now
  )
    invalid("invitation is invalid, expired, used or revoked");
  if (invite.email_normalized !== normalizeEmail(verifiedEmail))
    invalid("sign in with the invited email address");
  if (
    db
      .prepare("SELECT 1 FROM organization_members WHERE account_id=?")
      .get(actor)
  )
    invalid("you already belong to an organization");
  db.prepare("INSERT INTO organization_members VALUES(?,?,'member',?,?)").run(
    invite.organization_id,
    actor,
    invite.email_normalized,
    now,
  );
  db.prepare(
    "UPDATE organization_invitations SET accepted_account_id=?,accepted_at_ms=? WHERE id=?",
  ).run(actor, now, invite.id);
  let seat = false;
  if (invite.assign_seat) {
    try {
      db.transaction(() =>
        assignToMember(db, invite.organization_id, actor, now),
      ).immediate();
      seat = true;
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "quota_exhausted"))
        throw error;
    }
  }
  return {
    joined: true,
    organizationId: invite.organization_id.toString(),
    seat,
    ...(invite.assign_seat && !seat ? { reason: "no_free_seat" } : {}),
  };
}

export function resolveFundingContext(
  db: Db,
  account: bigint,
  choice: FundingChoice = PERSONAL,
  now: bigint,
): FundingContext {
  if (choice.kind === "personal") return PERSONAL;
  const assignment = db
    .prepare<[bigint, bigint], { id: bigint }>(
      "SELECT a.id FROM seat_assignments a JOIN seats s ON s.id=a.seat_id WHERE a.account_id=? AND s.organization_id=? AND a.ended_at_ms IS NULL",
    )
    .get(account, BigInt(choice.organizationId));
  if (!assignment)
    throw new ApiError(
      "no_seat",
      "you do not have an assigned organization seat",
    );
  const context: FundingContext = {
    kind: "organization",
    organizationId: BigInt(choice.organizationId),
    assignmentId: assignment.id,
  };
  assertFunding(db, account, context, now);
  return context;
}

export function endAssignment(
  state: ServiceState,
  assignmentId: bigint,
  reason: string,
  now: bigint,
) {
  const db = state.db;
  transactionRequired(db);
  const assignment = db
    .prepare<[bigint], Assignment>("SELECT * FROM seat_assignments WHERE id=?")
    .get(assignmentId);
  if (!assignment || assignment.ended_at_ms !== null) return () => {};
  const sessions = db
    .prepare<[bigint], SessionRow>(
      "SELECT * FROM managed_sessions WHERE funding_scope='organization' AND funding_assignment_id=? AND state IN ('active','paused')",
    )
    .all(assignmentId);
  for (const session of sessions) {
    const live = state.sessions.get(session.id);
    // Only confirmed delivered coverage may be charged when a seat is revoked.
    const end = live
      ? live.deliveredUntilMs < now
        ? live.deliveredUntilMs
        : now
      : (session.billable_since_ms ?? now);
    finishInterval(
      db,
      session.account_id,
      session.local_session_id,
      "seat_revoked",
      end,
    );
    db.prepare(
      "UPDATE managed_sessions SET state='stopped',lease_version=lease_version+1,lease_expires_ms=NULL,updated_at_ms=? WHERE id=?",
    ).run(now, session.id);
  }
  const requests = db
    .prepare<[bigint], { account_id: bigint; request_key: string }>(
      "SELECT account_id,request_key FROM provider_requests WHERE funding_assignment_id=? AND state='pending'",
    )
    .all(assignmentId);
  for (const request of requests)
    releaseBrief(db, request.account_id, request.request_key, now);
  const grants = db
    .prepare<[bigint], Grant>(
      "SELECT * FROM allowance_grants WHERE seat_assignment_id=? AND revoked=0",
    )
    .all(assignmentId);
  for (const grant of grants) {
    if (grant.meeting_ms_reserved !== 0n || grant.briefs_reserved !== 0n)
      throw new Error("Seat still has reservations during revocation");
    db.prepare(
      "UPDATE allowance_grants SET revoked=1,revocation_reason='assignment_ended' WHERE id=?",
    ).run(grant.id);
    recordUsage(
      db,
      assignment.account_id,
      grant.id,
      null,
      null,
      "seat_release",
      grant.meeting_ms_total - grant.meeting_ms_used,
      grant.briefs_total - grant.briefs_used,
      `seat-release:${grant.id}`,
      now,
    );
  }
  db.prepare(
    "UPDATE seat_assignments SET ended_at_ms=?,end_reason=? WHERE id=?",
  ).run(now, reason, assignmentId);
  for (const period of db
    .prepare<[bigint], SeatPeriod>("SELECT * FROM seat_periods WHERE seat_id=?")
    .all(assignment.seat_id))
    assertSeatConservation(db, period);
  return () => {
    for (const session of sessions) state.sessions.delete(session.id);
    for (const entry of state.cancellations
      .get(assignment.account_id)
      ?.values() ?? [])
      if (entry.fundingAssignmentId === assignmentId) entry.controller.abort();
  };
}
export function unassignSeat(
  state: ServiceState,
  actor: bigint,
  org: bigint,
  seat: bigint,
  now: bigint,
) {
  transactionRequired(state.db);
  requireOwner(state.db, actor, org);
  if (
    !state.db
      .prepare("SELECT 1 FROM seats WHERE id=? AND organization_id=?")
      .get(seat, org)
  )
    denied();
  const assignment = state.db
    .prepare<[bigint], { id: bigint }>(
      "SELECT id FROM seat_assignments WHERE seat_id=? AND ended_at_ms IS NULL",
    )
    .get(seat);
  return assignment
    ? endAssignment(state, assignment.id, "unassigned", now)
    : () => {};
}
export function removeMember(
  state: ServiceState,
  actor: bigint,
  org: bigint,
  account: bigint,
  now: bigint,
) {
  const db = state.db;
  transactionRequired(db);
  if (actor !== account) requireOwner(db, actor, org);
  const member = db
    .prepare<[bigint, bigint], { role: string }>(
      "SELECT role FROM organization_members WHERE organization_id=? AND account_id=?",
    )
    .get(org, account);
  if (!member) denied();
  if (member.role === "owner")
    invalid("transfer ownership before leaving or removing the owner");
  const assignment = db
    .prepare<[bigint, bigint], { id: bigint }>(
      "SELECT a.id FROM seat_assignments a JOIN seats s ON s.id=a.seat_id WHERE a.account_id=? AND s.organization_id=? AND a.ended_at_ms IS NULL",
    )
    .get(account, org);
  const cleanup = assignment
    ? endAssignment(state, assignment.id, "membership_ended", now)
    : () => {};
  db.prepare(
    "DELETE FROM organization_members WHERE organization_id=? AND account_id=?",
  ).run(org, account);
  return cleanup;
}
export function transferOwner(
  db: Db,
  actor: bigint,
  org: bigint,
  target: bigint,
) {
  transactionRequired(db);
  requireOwner(db, actor, org);
  if (target === actor) return;
  if (
    !db
      .prepare(
        "SELECT 1 FROM organization_members WHERE organization_id=? AND account_id=? AND role='member'",
      )
      .get(org, target)
  )
    denied();
  if (
    db
      .prepare(
        "UPDATE organization_members SET role='member' WHERE organization_id=? AND account_id=? AND role='owner'",
      )
      .run(org, actor).changes !== 1 ||
    db
      .prepare(
        "UPDATE organization_members SET role='owner' WHERE organization_id=? AND account_id=? AND role='member'",
      )
      .run(org, target).changes !== 1
  )
    throw new Error("Owner transfer failed");
}

export function organizationView(db: Db, actor: bigint, now: bigint) {
  const base = {
    catalog: CATALOG,
    teamPurchaseEnabled: teamPurchasesEnabled(db),
  };
  const member = db
    .prepare<[bigint], { organization_id: bigint; role: string; name: string }>(
      "SELECT m.organization_id,m.role,o.name FROM organization_members m JOIN organizations o ON o.id=m.organization_id WHERE m.account_id=?",
    )
    .get(actor);
  if (!member) return { ...base, organization: null };
  const org = member.organization_id;
  const own = db
    .prepare<
      [bigint, bigint],
      { id: bigint; seat_id: bigint; seat_number: bigint }
    >(
      "SELECT a.id,a.seat_id,s.seat_number FROM seat_assignments a JOIN seats s ON s.id=a.seat_id WHERE a.account_id=? AND s.organization_id=? AND a.ended_at_ms IS NULL",
    )
    .get(actor, org);
  const usage = (seat: bigint) =>
    db
      .prepare<
        [bigint, bigint, bigint],
        {
          meetingMsUsed: bigint;
          briefsUsed: bigint;
          meetingMsTotal: bigint;
          briefsTotal: bigint;
          endsMs: bigint | null;
        }
      >(
        `SELECT COALESCE(sum((SELECT COALESCE(sum(g.meeting_ms_used),0) FROM allowance_grants g WHERE g.seat_period_id=p.id)),0) AS meetingMsUsed,
    COALESCE(sum((SELECT COALESCE(sum(g.meeting_ms_reserved),0) FROM allowance_grants g WHERE g.seat_period_id=p.id)),0) AS meetingMsReserved,
    COALESCE(sum((SELECT COALESCE(sum(g.briefs_used),0) FROM allowance_grants g WHERE g.seat_period_id=p.id)),0) AS briefsUsed,
    COALESCE(sum((SELECT COALESCE(sum(g.briefs_reserved),0) FROM allowance_grants g WHERE g.seat_period_id=p.id)),0) AS briefsReserved,
    COALESCE(sum(p.budget_ms),0) AS meetingMsTotal,COALESCE(sum(p.budget_briefs),0) AS briefsTotal,max(p.ends_ms) AS endsMs
    FROM seat_periods p WHERE p.seat_id=? AND p.financial_status='paid' AND p.starts_ms<=? AND p.ends_ms>?`,
      )
      .get(seat, now, now)!;
  const organization = {
    id: org.toString(),
    name: member.name,
    role: member.role,
    assignment: own
      ? {
          id: own.id.toString(),
          seatId: own.seat_id.toString(),
          seatNumber: own.seat_number,
          allowance: usage(own.seat_id),
        }
      : null,
  };
  if (member.role !== "owner") return { ...base, organization };
  const seats = db
    .prepare<
      [bigint],
      {
        id: bigint;
        seat_number: bigint;
        status: string;
        account_id: bigint | null;
      }
    >(
      "SELECT s.id,s.seat_number,s.status,a.account_id FROM seats s LEFT JOIN seat_assignments a ON a.seat_id=s.id AND a.ended_at_ms IS NULL WHERE s.organization_id=? ORDER BY s.seat_number",
    )
    .all(org);
  const members = db
    .prepare<
      [bigint],
      { account_id: bigint; role: string; display_email: string | null }
    >(
      "SELECT account_id,role,display_email FROM organization_members WHERE organization_id=? ORDER BY account_id",
    )
    .all(org);
  const invitations = db
    .prepare<
      [bigint, bigint],
      {
        id: bigint;
        email_normalized: string;
        expires_ms: bigint;
        delivery_state: string;
        assign_seat: bigint;
      }
    >(
      "SELECT id,email_normalized,expires_ms,delivery_state,assign_seat FROM organization_invitations WHERE organization_id=? AND revoked=0 AND accepted_at_ms IS NULL AND expires_ms>? ORDER BY id",
    )
    .all(org, now);
  const subscription =
    db
      .prepare(
        "SELECT status,quantity_next AS quantityNext,paid_through_ms AS paidThroughMs,cancel_at_period_end AS cancelAtPeriodEnd,external_change AS externalChange FROM organization_subscriptions WHERE organization_id=?",
      )
      .get(org) ?? null;
  const pendingCheckout =
    db
      .prepare<[bigint], { id: bigint; quantity: bigint; state: string }>(
        "SELECT id,quantity,state FROM organization_checkouts WHERE organization_id=? AND state IN ('pending','payment_pending','unknown')",
      )
      .get(org) ?? null;
  const pendingQuantityChange =
    db
      .prepare<[bigint], { quantity: bigint; state: string }>(
        "SELECT quantity,state FROM organization_quantity_changes WHERE organization_id=? AND state IN ('pending','unknown')",
      )
      .get(org) ?? null;
  return {
    ...base,
    organization: {
      ...organization,
      subscription,
      pendingCheckout: pendingCheckout
        ? { ...pendingCheckout, id: pendingCheckout.id.toString() }
        : null,
      pendingQuantityChange,
      paidCapacity: db
        .prepare<[bigint, bigint, bigint], { n: bigint }>(
          "SELECT count(DISTINCT seat_id) AS n FROM seat_periods WHERE organization_id=? AND financial_status='paid' AND starts_ms<=? AND ends_ms>?",
        )
        .get(org, now, now)!.n,
      seats: seats.map((s) => ({
        id: s.id.toString(),
        number: s.seat_number,
        status: s.status,
        accountId: s.account_id?.toString() ?? null,
        usage: usage(s.id),
      })),
      members: members.map((m) => ({
        accountId: m.account_id.toString(),
        role: m.role,
        email: m.display_email,
      })),
      invitations: invitations.map((i) => ({
        id: i.id.toString(),
        email: i.email_normalized,
        expiresMs: i.expires_ms,
        deliveryState: i.delivery_state,
        assignSeat: i.assign_seat === 1n,
      })),
    },
  };
}

export function organizationAccountSummary(
  db: Db,
  actor: bigint,
  now: bigint,
  issuer: string,
) {
  const member = db
    .prepare<[bigint], { organization_id: bigint; role: string; name: string }>(
      "SELECT m.organization_id,m.role,o.name FROM organization_members m JOIN organizations o ON o.id=m.organization_id WHERE m.account_id=?",
    )
    .get(actor);
  if (!member) return { organization: null, organizationAllowance: null };
  const assignment = db
    .prepare<
      [bigint, bigint],
      { id: bigint; seat_id: bigint; seat_number: bigint }
    >(
      "SELECT a.id,a.seat_id,s.seat_number FROM seat_assignments a JOIN seats s ON s.id=a.seat_id WHERE a.account_id=? AND s.organization_id=? AND a.ended_at_ms IS NULL",
    )
    .get(actor, member.organization_id);
  const period = assignment
    ? db
        .prepare<[bigint, bigint, bigint], SeatPeriod>(
          "SELECT * FROM seat_periods WHERE seat_id=? AND financial_status='paid' AND starts_ms<=? AND ends_ms>? ORDER BY starts_ms DESC LIMIT 1",
        )
        .get(assignment.seat_id, now, now)
    : undefined;
  const spent = period
    ? db
        .prepare<
          [bigint],
          {
            usedMs: bigint;
            reservedMs: bigint;
            usedBriefs: bigint;
            reservedBriefs: bigint;
          }
        >(
          "SELECT COALESCE(sum(meeting_ms_used),0) AS usedMs,COALESCE(sum(meeting_ms_reserved),0) AS reservedMs,COALESCE(sum(briefs_used),0) AS usedBriefs,COALESCE(sum(briefs_reserved),0) AS reservedBriefs FROM allowance_grants WHERE seat_period_id=?",
        )
        .get(period.id)!
    : undefined;
  return {
    organization: {
      id: member.organization_id.toString(),
      name: member.name,
      role: member.role,
      seatId: assignment?.seat_id.toString() ?? null,
      seatNumber: assignment?.seat_number ?? null,
      assignmentId: assignment?.id.toString() ?? null,
      seatPeriodEndMs: period?.ends_ms ?? null,
      teamUrl: new URL("/team", issuer).href,
      minimumDesktopVersion: "0.1.5",
    },
    organizationAllowance:
      period && spent
        ? {
            totalMs: period.budget_ms,
            totalBriefs: period.budget_briefs,
            ...spent,
          }
        : null,
  };
}
