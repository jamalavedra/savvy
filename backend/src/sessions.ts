import type { Db } from "./db.js";
import type { ServiceState } from "./state.js";
import { ApiError } from "./errors.js";
import { balance, reserveAttempt, recordUsage, min, max } from "./billing.js";

export const RESERVATION_MS = 30_000n;
export const CHECKPOINT_MS = 5_000n;
export const AUDIO_IDLE_MS = 5_000n;
export const LEASE_MS = RESERVATION_MS;
export const BYTES_PER_SECOND = 32_000n;
export type Source = "microphone" | "system";
export function parseSource(value: string): Source {
  if (value !== "microphone" && value !== "system")
    throw new ApiError(
      "invalid_request",
      "source must be microphone or system",
    );
  return value;
}
export function validateSessionId(value: string) {
  let raw = value.trim();
  if (raw.length === 45 && raw.startsWith("urn:uuid:")) raw = raw.slice(9);
  else if (raw.length === 38 && raw.startsWith("{") && raw.endsWith("}"))
    raw = raw.slice(1, -1);
  if (
    !/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/.test(
      raw,
    )
  )
    throw new ApiError("invalid_request", "sessionId must be a UUID");
  return raw
    .replaceAll("-", "")
    .toLowerCase()
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}
interface SourceState {
  generation: bigint;
  connected: boolean;
  lastAudioMs: bigint;
  bytes: bigint;
  startedMs: bigint;
  audioEndUnits: bigint;
  recentAudio: [bigint, bigint][];
}
export interface LiveSession {
  sources: Map<Source, SourceState>;
  deliveredUntilMs: bigint;
}
export interface SessionRow {
  id: bigint;
  account_id: bigint;
  local_session_id: string;
  state: string;
  lease_version: bigint;
  lease_expires_ms: bigint | null;
  reserved_ms: bigint;
  settled_ms: bigint;
  billable_since_ms: bigint | null;
}
export interface SessionView {
  sessionId: string;
  state: string;
  leaseVersion: bigint;
  leaseExpiresMs: bigint;
  settledMs: bigint;
  meetingMsAvailable: bigint;
  warning: string | null;
}
function freshSource(now = 0n): SourceState {
  return {
    generation: 0n,
    connected: false,
    lastAudioMs: now,
    bytes: 0n,
    startedMs: now,
    audioEndUnits: now * 32n,
    recentAudio: [],
  };
}
function liveSession(state: ServiceState, id: bigint) {
  let live = state.sessions.get(id);
  if (!live) {
    live = { sources: new Map(), deliveredUntilMs: 0n };
    state.sessions.set(id, live);
  }
  return live;
}
function readSession(db: Db, account: bigint, id: string) {
  return db
    .prepare<[bigint, string], SessionRow>(
      "SELECT id,account_id,local_session_id,state,lease_version,lease_expires_ms,reserved_ms,settled_ms,billable_since_ms FROM managed_sessions WHERE account_id=? AND local_session_id=?",
    )
    .get(account, id);
}
export function requireSession(db: Db, account: bigint, id: string) {
  const session = readSession(db, account, id);
  if (!session)
    throw new ApiError(
      "session_conflict",
      "this meeting session is not active for your account",
    );
  return session;
}
function requireTransaction(db: Db) {
  if (!db.inTransaction)
    throw new Error("Session ledger changes require a transaction");
}

function setReservation(
  db: Db,
  session: SessionRow,
  desired: bigint,
  now: bigint,
) {
  requireTransaction(db);
  db.prepare(
    "UPDATE allowance_grants SET meeting_ms_reserved=meeting_ms_reserved-COALESCE((SELECT amount_ms FROM session_reservations WHERE session_id=? AND grant_id=allowance_grants.id),0)",
  ).run(session.id);
  db.prepare("DELETE FROM session_reservations WHERE session_id=?").run(
    session.id,
  );
  const rows = db
    .prepare<
      [bigint, bigint, bigint, bigint],
      { id: bigint; available: bigint }
    >(
      "SELECT id,min(meeting_ms_total-meeting_ms_used-meeting_ms_reserved,COALESCE(valid_until_ms-?,9223372036854775807)) AS available FROM allowance_grants WHERE account_id=? AND revoked=0 AND valid_from_ms<=? AND (valid_until_ms IS NULL OR valid_until_ms>?) ORDER BY (valid_until_ms IS NULL),valid_until_ms,created_at_ms,id",
    )
    .all(now, session.account_id, now, now);
  let remaining = max(desired, 0n);
  for (const row of rows) {
    const take = min(remaining, max(row.available, 0n));
    if (!take) continue;
    db.prepare("INSERT INTO session_reservations VALUES(?,?,?)").run(
      session.id,
      row.id,
      take,
    );
    db.prepare(
      "UPDATE allowance_grants SET meeting_ms_reserved=meeting_ms_reserved+? WHERE id=?",
    ).run(take, row.id);
    remaining -= take;
  }
  const reserved = max(desired, 0n) - remaining;
  db.prepare(
    "UPDATE managed_sessions SET reserved_ms=?,updated_at_ms=? WHERE id=?",
  ).run(reserved, now, session.id);
  return reserved;
}

function spendInterval(
  db: Db,
  session: SessionRow,
  since: bigint,
  until: bigint,
) {
  const key = `session:${session.id}:${since}:${until}`;
  const previous = db
    .prepare<[string], { amount_ms: bigint }>(
      "SELECT amount_ms FROM usage_events WHERE operation_key=?",
    )
    .get(key);
  if (previous) return previous.amount_ms;
  const rows = db
    .prepare<
      [bigint],
      {
        id: bigint;
        amount_ms: bigint;
        valid_from_ms: bigint;
        valid_until_ms: bigint | null;
        revoked: bigint;
      }
    >(
      "SELECT g.id,r.amount_ms,g.valid_from_ms,g.valid_until_ms,g.revoked FROM session_reservations r JOIN allowance_grants g ON g.id=r.grant_id WHERE r.session_id=? ORDER BY (g.valid_until_ms IS NULL),g.valid_until_ms,g.created_at_ms,g.id",
    )
    .all(session.id);
  let cursor = since,
    spent = 0n;
  for (const row of rows) {
    if (row.revoked) continue;
    const start = max(cursor, row.valid_from_ms);
    const take = min(
      max(min(until, row.valid_until_ms ?? until) - start, 0n),
      row.amount_ms,
    );
    if (!take) continue;
    db.prepare(
      "UPDATE allowance_grants SET meeting_ms_used=meeting_ms_used+?,meeting_ms_reserved=meeting_ms_reserved-? WHERE id=?",
    ).run(take, take, row.id);
    db.prepare(
      "UPDATE session_reservations SET amount_ms=amount_ms-? WHERE session_id=? AND grant_id=?",
    ).run(take, session.id, row.id);
    recordUsage(
      db,
      session.account_id,
      row.id,
      session.local_session_id,
      null,
      "debit_meeting",
      take,
      0n,
      `${key}:grant:${row.id}`,
      until,
    );
    cursor = start + take;
    spent += take;
  }
  recordUsage(
    db,
    session.account_id,
    null,
    session.local_session_id,
    null,
    "settlement",
    spent,
    0n,
    key,
    until,
  );
  return spent;
}

export function createSession(
  db: Db,
  account: bigint,
  id: string,
  now: bigint,
): SessionRow {
  requireTransaction(db);
  const existing = readSession(db, account, id);
  if (existing) {
    if (existing.state === "stopped")
      throw new ApiError("session_conflict", "this meeting already ended");
    return existing;
  }
  reserveAttempt(db, account, "session", now, 3_600_000n, 120n);
  db.prepare(
    "DELETE FROM managed_sessions WHERE account_id=? AND state='stopped' AND settled_ms=0 AND reserved_ms=0 AND updated_at_ms<? AND NOT EXISTS(SELECT 1 FROM session_reservations WHERE session_id=managed_sessions.id) AND NOT EXISTS(SELECT 1 FROM usage_events WHERE account_id=? AND session_id=managed_sessions.local_session_id)",
  ).run(account, now - 86_400_000n, account);
  const empty = db
    .prepare<[bigint], { n: bigint }>(
      "SELECT count(*) AS n FROM managed_sessions WHERE account_id=? AND settled_ms=0",
    )
    .get(account)!.n;
  if (empty >= 1024n)
    throw new ApiError("rate_limited", "session limit reached", 3_600_000n);
  db.prepare(
    "UPDATE managed_sessions SET state='stopped',lease_version=lease_version+1,lease_expires_ms=NULL,interruption='superseded_paused_meeting',updated_at_ms=? WHERE account_id=? AND state='paused' AND reserved_ms=0",
  ).run(now, account);
  if (
    db
      .prepare(
        "SELECT 1 FROM managed_sessions WHERE account_id=? AND state IN ('active','paused') LIMIT 1",
      )
      .get(account)
  )
    throw new ApiError(
      "session_conflict",
      "another assisted meeting is already running on this account",
    );
  if (balance(db, account, now).meetingMsAvailable <= 0n)
    throw new ApiError(
      "quota_exhausted",
      "no meeting time remains; buy an hours pack to continue",
    );
  db.prepare(
    "INSERT INTO managed_sessions(account_id,local_session_id,state,lease_version,lease_expires_ms,created_at_ms,updated_at_ms) VALUES(?,?,'active',1,?,?,?)",
  ).run(account, id, now + LEASE_MS, now, now);
  setReservation(db, requireSession(db, account, id), RESERVATION_MS, now);
  return requireSession(db, account, id);
}

function settleTo(
  db: Db,
  session: SessionRow,
  now: bigint,
  close: boolean,
): [bigint, boolean] {
  const since = session.billable_since_ms;
  if (since === null) return [0n, false];
  const elapsed = max(now - since, 0n);
  if (!elapsed && !close) return [0n, false];
  const spent = elapsed ? spendInterval(db, session, since, now) : 0n;
  db.prepare(
    "UPDATE managed_sessions SET settled_ms=settled_ms+?,billable_since_ms=?,reserved_ms=reserved_ms-?,updated_at_ms=? WHERE id=?",
  ).run(
    spent,
    close ? null : now,
    min(spent, session.reserved_ms),
    now,
    session.id,
  );
  return [spent, spent < elapsed];
}
function finishInterval(
  db: Db,
  account: bigint,
  id: string,
  reason: string,
  now: bigint,
) {
  const [spent] = settleTo(db, requireSession(db, account, id), now, true);
  setReservation(db, requireSession(db, account, id), 0n, now);
  db.prepare(
    "UPDATE managed_sessions SET interruption=?,updated_at_ms=? WHERE account_id=? AND local_session_id=?",
  ).run(reason, now, account, id);
  return spent;
}

export function sourceGeneration(
  state: ServiceState,
  row: bigint,
  source: Source,
) {
  return state.sessions.get(row)?.sources.get(source)?.generation ?? -1n;
}
let nextGeneration = 1n;
export function attachSource(
  state: ServiceState,
  session: SessionRow,
  source: Source,
  now: bigint,
) {
  const live = liveSession(state, session.id);
  const entry = live.sources.get(source) ?? freshSource();
  entry.generation = nextGeneration++;
  entry.connected = true;
  if (entry.startedMs === 0n) entry.startedMs = now;
  live.sources.set(source, entry);
  return entry.generation;
}
export function detachSource(
  state: ServiceState,
  row: bigint,
  source: Source,
  generation: bigint,
) {
  const entry = state.sessions.get(row)?.sources.get(source);
  if (entry?.generation === generation) {
    entry.generation++;
    entry.connected = false;
  }
}
export function healthyAudio(state: ServiceState, row: bigint, now: bigint) {
  return [...(state.sessions.get(row)?.sources.values() ?? [])].some(
    (s) =>
      s.connected &&
      s.lastAudioMs > 0n &&
      now - s.lastAudioMs < AUDIO_IDLE_MS &&
      s.recentAudio.reduce(
        (total, [start, end]) =>
          total +
          max(
            0n,
            min(end, now * 32n) - max(start, (now - AUDIO_IDLE_MS) * 32n),
          ),
        0n,
      ) >=
        4000n * 32n,
  );
}
export function checkAudio(
  state: ServiceState,
  row: bigint,
  source: Source,
  generation: bigint,
  bytes: number,
  now: bigint,
) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % 2 !== 0)
    throw new ApiError("invalid_request", "invalid PCM frame");
  const account = state.db
    .prepare<[bigint], { account_id: bigint }>(
      "SELECT account_id FROM managed_sessions WHERE id=?",
    )
    .get(row)?.account_id;
  if (account === undefined)
    throw new ApiError(
      "session_conflict",
      "this meeting session is not active",
    );
  state.db
    .transaction(() => {
      reserveAttempt(state.db, account, "audio_frame", now, 1000n, 200n);
      const previous = state.db
        .prepare<[bigint, string], { debt: bigint; updated_ms: bigint }>(
          "SELECT debt,updated_ms FROM audio_pacing WHERE account_id=? AND source=?",
        )
        .get(account, source);
      const debt =
        max(
          (previous?.debt ?? 0n) -
            max(now - (previous?.updated_ms ?? now), 0n) * 32n,
          0n,
        ) + BigInt(bytes);
      if (debt > BYTES_PER_SECOND)
        throw new ApiError(
          "invalid_request",
          "audio exceeds account real-time pacing",
        );
      state.db
        .prepare("INSERT OR REPLACE INTO audio_pacing VALUES(?,?,?,?)")
        .run(account, source, debt, now);
    })
    .immediate();
  const entry = state.sessions.get(row)?.sources.get(source) ?? freshSource();
  if (entry.generation !== generation)
    throw new ApiError("session_conflict", "superseded audio connection");
  if (
    max(entry.bytes - max(now - entry.startedMs, 0n) * 32n, 0n) +
      BigInt(bytes) >
    BYTES_PER_SECOND
  )
    throw new ApiError(
      "invalid_request",
      "audio is being uploaded faster than real time",
    );
}

export function onAudio(
  state: ServiceState,
  account: bigint,
  id: string,
  source: Source,
  bytes: number,
  now: bigint,
  expected?: { version: bigint; generation: bigint },
): "continue" | "exhausted" {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % 2)
    throw new ApiError("invalid_request", "invalid PCM frame");
  let updated: { row: bigint; live: LiveSession } | undefined;
  const outcome = state.db
    .transaction(() => {
      const db = state.db;
      let session = requireSession(db, account, id);
      if (
        expected &&
        (expected.version !== session.lease_version ||
          sourceGeneration(state, session.id, source) !== expected.generation)
      )
        throw new ApiError("session_conflict", "stale audio owner");
      if (
        session.state !== "active" ||
        session.lease_expires_ms === null ||
        session.lease_expires_ms <= now
      )
        return "exhausted";
      if (
        db
          .prepare<[bigint], { disabled: bigint }>(
            "SELECT disabled FROM accounts WHERE id=?",
          )
          .get(account)!.disabled
      )
        throw new ApiError("sign_in_required", "account disabled");
      const previous = state.sessions.get(session.id);
      const live: LiveSession = {
        sources: new Map(
          [...(previous?.sources ?? [])].map(([key, value]) => [
            key,
            { ...value, recentAudio: [...value.recentAudio] },
          ]),
        ),
        deliveredUntilMs: previous?.deliveredUntilMs ?? 0n,
      };
      const previousEnd = live.deliveredUntilMs;
      const entry = live.sources.get(source) ?? freshSource(now);
      const debt =
        max(entry.bytes - max(now - entry.startedMs, 0n) * 32n, 0n) +
        BigInt(bytes);
      if (debt > BYTES_PER_SECOND)
        throw new ApiError(
          "invalid_request",
          "audio is being uploaded faster than real time",
        );
      entry.bytes = debt;
      entry.connected = true;
      entry.startedMs = now;
      entry.lastAudioMs = now;
      // One unit is 1/32 ms. Retain fractional samples across frames and gaps.
      const startUnits = max(
        entry.audioEndUnits,
        now * 32n + (entry.audioEndUnits % 32n),
      );
      entry.audioEndUnits = startUnits + BigInt(bytes);
      entry.recentAudio = entry.recentAudio.filter(
        ([, end]) => end > (now - AUDIO_IDLE_MS) * 32n,
      );
      const last = entry.recentAudio.at(-1);
      if (last && last[1] >= startUnits)
        entry.recentAudio[entry.recentAudio.length - 1] = [
          last[0],
          entry.audioEndUnits,
        ];
      else entry.recentAudio.push([startUnits, entry.audioEndUnits]);
      // Normal PCM merges into one interval; cap deliberately fragmented input.
      if (entry.recentAudio.length > 256) entry.recentAudio.shift();
      live.deliveredUntilMs = max(
        live.deliveredUntilMs,
        entry.audioEndUnits / 32n,
      );
      live.sources.set(source, entry);
      if (
        session.billable_since_ms !== null &&
        previousEnd > 0n &&
        now > previousEnd
      )
        settleTo(db, session, previousEnd, true);
      session = requireSession(db, account, id);
      if (session.billable_since_ms === null)
        db.prepare(
          "UPDATE managed_sessions SET billable_since_ms=?,updated_at_ms=? WHERE id=?",
        ).run(now, now, session.id);
      session = requireSession(db, account, id);
      const since = session.billable_since_ms ?? now;
      let exhausted = false;
      // Gaps settle coverage and reset `since`; replenish by remaining
      // reservation too, before a later contiguous frame can overrun it.
      const checkpoint =
        now - since >= min(CHECKPOINT_MS, session.reserved_ms) ||
        session.reserved_ms <= RESERVATION_MS - CHECKPOINT_MS;
      if (checkpoint) [, exhausted] = settleTo(db, session, now, false);
      session = requireSession(db, account, id);
      const reserved = checkpoint
        ? setReservation(db, session, RESERVATION_MS, now)
        : session.reserved_ms;
      if (reserved === 0n) exhausted = true;
      db.prepare(
        "UPDATE managed_sessions SET lease_expires_ms=?,updated_at_ms=? WHERE id=?",
      ).run(now + LEASE_MS, now, session.id);
      if (exhausted) {
        finishInterval(db, account, id, "exhausted", now);
        db.prepare(
          "UPDATE managed_sessions SET state='paused',lease_version=lease_version+1,lease_expires_ms=NULL WHERE id=?",
        ).run(session.id);
      }
      updated = { row: session.id, live };
      return exhausted ? "exhausted" : "continue";
    })
    .immediate();
  if (updated) state.sessions.set(updated.row, updated.live);
  return outcome;
}

export function onIdleCheck(
  state: ServiceState,
  account: bigint,
  id: string,
  now: bigint,
) {
  const session = readSession(state.db, account, id);
  if (!session) return true;
  const live = state.sessions.get(session.id);
  const idle = [...(live?.sources.values() ?? [])].every(
    (s) => now - s.lastAudioMs >= AUDIO_IDLE_MS,
  );
  if (!idle || session.billable_since_ms === null) return idle;
  state.db
    .transaction(() =>
      finishInterval(
        state.db,
        account,
        id,
        "audio_idle",
        min(live?.deliveredUntilMs ?? 0n, now),
      ),
    )
    .immediate();
  return true;
}
export function sessionView(
  db: Db,
  account: bigint,
  id: string,
  now: bigint,
): SessionView {
  const session = requireSession(db, account, id),
    available = balance(db, account, now);
  const remaining = available.meetingMsAvailable + available.meetingMsReserved;
  const warning =
    remaining === 0n
      ? "exhausted"
      : remaining <= 120_000n
        ? "two_minutes_left"
        : remaining <= 600_000n
          ? "ten_minutes_left"
          : available.monthlyMsTotal > 0n &&
              available.monthlyMsUsed * 100n >= available.monthlyMsTotal * 80n
            ? "monthly_eighty_percent"
            : null;
  return {
    sessionId: session.local_session_id,
    state: session.state,
    leaseVersion: session.lease_version,
    leaseExpiresMs: session.lease_expires_ms ?? 0n,
    settledMs: session.settled_ms,
    meetingMsAvailable: remaining,
    warning,
  };
}
export function lifecycle(
  state: ServiceState,
  account: bigint,
  id: string,
  action: "pause" | "resume" | "stop",
  version: bigint,
  command: bigint,
) {
  const now = state.clock();
  let changed = false;
  const view = state.db
    .transaction(() => {
      const db = state.db,
        session = requireSession(db, account, id);
      const last = db
        .prepare<[bigint], { lifecycle_command: bigint }>(
          "SELECT lifecycle_command FROM managed_sessions WHERE id=?",
        )
        .get(session.id)!.lifecycle_command;
      if (command <= last) return sessionView(db, account, id, now);
      if (version !== session.lease_version)
        throw new ApiError("session_conflict", "invalid session lease");
      if (session.state === "stopped")
        throw new ApiError("session_conflict", "meeting ended");
      const end = min(
        state.sessions.get(session.id)?.deliveredUntilMs ?? 0n,
        now,
      );
      finishInterval(db, account, id, action, end > 0n ? end : now);
      if (action === "resume") {
        state.requireAssistance();
        if (
          setReservation(
            db,
            requireSession(db, account, id),
            RESERVATION_MS,
            now,
          ) === 0n
        )
          throw new ApiError("quota_exhausted", "buy a pack before resuming");
      }
      db.prepare(
        "UPDATE managed_sessions SET state=?,lease_version=lease_version+1,lease_expires_ms=?,lifecycle_command=? WHERE id=?",
      ).run(
        action === "resume"
          ? "active"
          : action === "stop"
            ? "stopped"
            : "paused",
        action === "resume" ? now + LEASE_MS : null,
        command,
        session.id,
      );
      changed = true;
      return sessionView(db, account, id, now);
    })
    .immediate();
  if (changed) {
    state.sessions.delete(requireSession(state.db, account, id).id);
    for (const controller of state.cancellations.get(account)?.values() ?? [])
      controller.abort();
  }
  return view;
}
export function settleDisconnectedSource(
  state: ServiceState,
  account: bigint,
  id: string,
  source: Source,
  generation: bigint,
) {
  state.db
    .transaction(() => {
      const db = state.db,
        session = requireSession(db, account, id);
      if (
        session.state !== "active" ||
        sourceGeneration(state, session.id, source) !== generation
      )
        return;
      const live = state.sessions.get(session.id)!;
      const remaining = [...live.sources].some(
        ([key, s]) => key !== source && s.connected,
      );
      settleTo(
        db,
        session,
        remaining
          ? min(live.deliveredUntilMs, state.clock())
          : live.deliveredUntilMs,
        !remaining,
      );
      if (!remaining) {
        setReservation(db, requireSession(db, account, id), 0n, state.clock());
        db.prepare(
          "UPDATE managed_sessions SET state='paused',lease_version=lease_version+1,lease_expires_ms=NULL WHERE id=?",
        ).run(session.id);
      }
    })
    .immediate();
  const session = requireSession(state.db, account, id);
  detachSource(state, session.id, source, generation);
}

export function abandonFailedSource(
  state: ServiceState,
  account: bigint,
  id: string,
  source: Source,
  generation: bigint,
) {
  const session = requireSession(state.db, account, id);
  if (
    session.state !== "active" ||
    sourceGeneration(state, session.id, source) !== generation
  )
    return;
  // Coverage is a union shared by both sources. Absorb its ambiguous tail once;
  // retain the reservation and lease so a reconnect can deliver fresh audio.
  state.db
    .prepare("UPDATE managed_sessions SET billable_since_ms=NULL WHERE id=?")
    .run(session.id);
  const live = state.sessions.get(session.id)!;
  live.deliveredUntilMs = 0n;
  for (const entry of live.sources.values()) {
    entry.audioEndUnits = state.clock() * 32n;
    entry.lastAudioMs = 0n;
    entry.recentAudio = [];
  }
}
export function recoverRestart(state: ServiceState) {
  state.db
    .transaction(() => {
      const rows = state.db
        .prepare<[], { account_id: bigint; local_session_id: string }>(
          "SELECT account_id,local_session_id FROM managed_sessions WHERE state IN ('active','paused')",
        )
        .all();
      for (const row of rows) {
        const session = requireSession(
          state.db,
          row.account_id,
          row.local_session_id,
        );
        setReservation(state.db, session, 0n, state.clock());
        state.db
          .prepare(
            "UPDATE managed_sessions SET state='stopped',billable_since_ms=NULL,lease_expires_ms=NULL,lease_version=lease_version+1,interruption='service_restart' WHERE id=?",
          )
          .run(session.id);
      }
      state.db
        .prepare(
          "UPDATE allowance_grants SET revoked=? WHERE kind='unmetered' AND revoked<>?",
        )
        .run(state.config.billing ? 1 : 0, state.config.billing ? 1 : 0);
    })
    .immediate();
  state.sessions.clear();
}

export function pauseSession(state: ServiceState, account: bigint, id: string) {
  const now = state.clock();
  const view = state.db
    .transaction(() => {
      const session = requireSession(state.db, account, id);
      if (session.state === "stopped")
        throw new ApiError("session_conflict", "this meeting already ended");
      const end = min(
        state.sessions.get(session.id)?.deliveredUntilMs ?? 0n,
        now,
      );
      finishInterval(state.db, account, id, "paused", end > 0n ? end : now);
      state.db
        .prepare(
          "UPDATE managed_sessions SET state='paused',lease_version=lease_version+1,lease_expires_ms=NULL,updated_at_ms=? WHERE id=?",
        )
        .run(now, session.id);
      return sessionView(state.db, account, id, now);
    })
    .immediate();
  state.sessions.delete(requireSession(state.db, account, id).id);
  for (const controller of state.cancellations.get(account)?.values() ?? [])
    controller.abort();
  return view;
}
export function expireStaleSessions(state: ServiceState) {
  const now = state.clock();
  const rows = state.db
    .prepare<
      [bigint],
      { id: bigint; account_id: bigint; local_session_id: string }
    >(
      "SELECT id,account_id,local_session_id FROM managed_sessions WHERE state='active' AND (lease_expires_ms IS NULL OR lease_expires_ms<=?)",
    )
    .all(now);
  for (const row of rows) {
    state.db
      .transaction(() => {
        const session = requireSession(
          state.db,
          row.account_id,
          row.local_session_id,
        );
        if (
          session.state !== "active" ||
          (session.lease_expires_ms !== null && session.lease_expires_ms > now)
        )
          return;
        state.db
          .prepare(
            "UPDATE managed_sessions SET billable_since_ms=NULL WHERE id=?",
          )
          .run(session.id);
        finishInterval(
          state.db,
          row.account_id,
          row.local_session_id,
          "lease_expired",
          now,
        );
        state.db
          .prepare(
            "UPDATE managed_sessions SET state='stopped',lease_version=lease_version+1,lease_expires_ms=NULL,updated_at_ms=? WHERE id=?",
          )
          .run(now, session.id);
      })
      .immediate();
    state.sessions.delete(row.id);
  }
  const active = new Set(
    state.db
      .prepare<[], { id: bigint }>(
        "SELECT id FROM managed_sessions WHERE state='active'",
      )
      .all()
      .map((s) => s.id),
  );
  state.db
    .prepare("DELETE FROM cancellation_tombstones WHERE expires_ms<=?")
    .run(now);
  for (const id of state.sessions.keys())
    if (!active.has(id)) state.sessions.delete(id);
  return rows.length;
}
