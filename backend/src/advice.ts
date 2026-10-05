import { z } from "zod";
import type { ServiceState } from "./state.js";
import { ApiError } from "./errors.js";
import {
  requestState,
  reserveAttempt,
  reserveBrief,
  releaseBrief,
  settleBriefSuccess,
} from "./billing.js";
import { refreshRenewal } from "./stripe.js";
import { healthyAudio, requireSession } from "./sessions.js";
import {
  available,
  requestBody,
  checkInput,
  generate,
  recordOutcome,
} from "./ai.js";
import {
  briefRequest,
  adviceRequest,
  contracts,
  briefPrompt,
  advicePrompt,
  safeRelativePath,
  validateBrief,
  validateAdvice,
} from "./context.js";

export const BRIEF_RESULT_TTL_MS = 300_000n;
export const briefBody = z.object({
  idempotencyKey: z.string(),
  request: briefRequest,
});
export const adviceBody = z
  .object({
    idempotencyKey: z.string(),
    leaseVersion: z.number().int(),
    request: adviceRequest,
  })
  .strict();
function acquire(state: ServiceState, account: bigint) {
  if (state.aiInFlight.has(account))
    throw new ApiError(
      "session_conflict",
      "another AI request for this account is already running",
    );
  state.aiInFlight.add(account);
}
function register(state: ServiceState, account: bigint, key: string) {
  if (requestState(state.db, account, key) !== "pending")
    throw new ApiError(
      "result_unavailable",
      "request canceled before dispatch",
    );
  const controller = new AbortController();
  let requests = state.cancellations.get(account);
  if (!requests) {
    requests = new Map();
    state.cancellations.set(account, requests);
  }
  requests.set(key, controller);
  return controller;
}
function cleanup(
  state: ServiceState,
  account: bigint,
  key: string,
  registered: boolean,
) {
  try {
    if (registered) {
      const requests = state.cancellations.get(account);
      requests?.delete(key);
      if (!requests?.size) state.cancellations.delete(account);
      state.db
        .transaction(() => releaseBrief(state.db, account, key, state.clock()))
        .immediate();
    }
  } finally {
    state.aiInFlight.delete(account);
  }
}
function abortFailure(
  signal: AbortSignal,
  deadline: AbortSignal,
  operation: string,
  error: unknown,
) {
  if (signal.aborted)
    return new ApiError(
      deadline.aborted ? "provider_unavailable" : "result_unavailable",
      `${operation} ${deadline.aborted ? "timed out" : "canceled"}`,
    );
  return error;
}
export function pruneResults(state: ServiceState) {
  const now = state.clock();
  for (const [account, results] of state.briefResults) {
    for (const [key, result] of results)
      if (now - result.at >= BRIEF_RESULT_TTL_MS) results.delete(key);
    if (!results.size) state.briefResults.delete(account);
  }
}
export function cancelRequest(
  state: ServiceState,
  account: bigint,
  key: string,
) {
  if (!key || Buffer.byteLength(key) > 128)
    throw new ApiError("invalid_request", "invalid cancellation key");
  state.db
    .transaction(() => {
      const now = state.clock();
      state.db
        .prepare("DELETE FROM cancellation_tombstones WHERE expires_ms<=?")
        .run(now);
      if (requestState(state.db, account, key) === undefined) {
        reserveAttempt(state.db, account, "cancel", now, 60_000n, 60n);
        const count = state.db
          .prepare<[bigint], { n: bigint }>(
            "SELECT count(*) AS n FROM cancellation_tombstones WHERE account_id=?",
          )
          .get(account)!.n;
        if (count >= 1024n)
          throw new ApiError(
            "rate_limited",
            "cancellation limit reached",
            60_000n,
          );
        state.db
          .prepare("INSERT INTO cancellation_tombstones VALUES(?,?,?)")
          .run(account, key, now + 86_400_000n);
      }
      releaseBrief(state.db, account, key, now);
    })
    .immediate();
  state.cancellations.get(account)?.get(key)?.abort();
  return { canceled: true };
}
export async function postBrief(
  state: ServiceState,
  account: bigint,
  body: z.infer<typeof briefBody>,
  disconnected: AbortSignal,
) {
  const key = body.idempotencyKey.trim();
  if (!key || Buffer.byteLength(key) > 128)
    throw new ApiError(
      "invalid_request",
      "idempotencyKey must be 1..=128 characters",
    );
  const previous = requestState(state.db, account, key),
    now = state.clock();
  if (previous !== undefined) {
    if (previous === "succeeded") {
      const cached = state.briefResults.get(account)?.get(key);
      if (cached && now - cached.at <= BRIEF_RESULT_TTL_MS) return cached.value;
      throw new ApiError(
        "result_unavailable",
        "this brief was already generated; the result is no longer held. Use a new request to generate again",
      );
    }
    throw previous === "pending"
      ? new ApiError(
          "session_conflict",
          "this brief request is already running",
        )
      : new ApiError(
          "result_unavailable",
          "this brief request already failed; retry with a new request",
        );
  }
  state.requireAdmission();
  acquire(state, account);
  const deadline = AbortSignal.timeout(120_000);
  let signal = AbortSignal.any([deadline, disconnected]);
  let reserved = false,
    registered = false;
  try {
    await available(state);
    await refreshRenewal(state, account);
    signal.throwIfAborted();
    for (const evidence of [
      ...body.request.guidance,
      ...body.request.clientEvidence,
    ])
      if (!safeRelativePath(evidence.relativePath))
        throw new ApiError(
          "invalid_request",
          "evidence paths must be relative",
        );
    const upstream = requestBody(
      state,
      briefPrompt(body.request),
      contracts.briefSchema,
    );
    state.db
      .transaction(() => {
        state.requireAssistance();
        reserveBrief(state.db, account, key, now);
        reserveAttempt(state.db, account, "brief", now, 60_000n, 6n);
        // Failed and canceled briefs are refunded, so attempts are the only
        // bound on paid generations per account.
        reserveAttempt(state.db, account, "brief", now, 86_400_000n, 20n);
        reserveAttempt(state.db, 0n, "brief", now, 60_000n, 300n);
      })
      .immediate();
    reserved = true;
    const controller = register(state, account, key);
    registered = true;
    signal = AbortSignal.any([signal, controller.signal]);
    let brief;
    try {
      await checkInput(state, upstream, 120_000, signal);
      brief = validateBrief(
        await generate(state, upstream, 4096, account, key, signal),
        body.request,
      );
      signal.throwIfAborted();
    } catch (error) {
      const failure = abortFailure(signal, deadline, "brief", error);
      if (
        failure instanceof ApiError &&
        failure.code === "provider_unavailable"
      )
        await recordOutcome(state, true, account);
      throw failure;
    }
    await recordOutcome(state, false, account);
    signal.throwIfAborted();
    state.db
      .transaction(() =>
        settleBriefSuccess(state.db, account, key, state.clock()),
      )
      .immediate();
    const response = { brief };
    pruneResults(state);
    let cache = state.briefResults.get(account);
    if (!cache) {
      cache = new Map();
      state.briefResults.set(account, cache);
    }
    cache.set(key, { at: state.clock(), value: response });
    return response;
  } catch (error) {
    throw error instanceof ApiError
      ? error
      : abortFailure(signal, deadline, "brief", error);
  } finally {
    try {
      if (reserved && !registered)
        state.db
          .transaction(() =>
            releaseBrief(state.db, account, key, state.clock()),
          )
          .immediate();
    } finally {
      cleanup(state, account, key, registered);
    }
  }
}
export function completeRequest(
  state: ServiceState,
  account: bigint,
  id: string,
  lease: bigint,
  key: string,
  now: bigint,
) {
  if (!state.db.inTransaction)
    throw new Error("Advice completion requires a transaction");
  const session = requireSession(state.db, account, id);
  const disabled = state.db
    .prepare<[bigint], { disabled: bigint }>(
      "SELECT disabled FROM accounts WHERE id=?",
    )
    .get(account)!.disabled;
  if (
    disabled ||
    session.state !== "active" ||
    session.lease_version !== lease ||
    session.lease_expires_ms === null ||
    session.lease_expires_ms <= now
  )
    throw new ApiError("result_unavailable", "stale recommendation");
  const changed = state.db
    .prepare(
      "UPDATE provider_requests SET state='succeeded' WHERE account_id=? AND request_key=? AND state='pending'",
    )
    .run(account, key).changes;
  if (changed !== 1)
    throw new ApiError(
      "result_unavailable",
      "recommendation canceled before completion",
    );
}
// Reserve 8,000 of the existing 24,000 input tokens for live transcript/ledger.
export async function checkMeetingContext(
  state: ServiceState,
  account: bigint,
  id: string,
  request: z.infer<typeof adviceRequest>,
  signal: AbortSignal,
) {
  state.requireAssistance();
  if (
    request.sessionId !== id ||
    request.evidence.some((e) => !safeRelativePath(e.relativePath))
  )
    throw new ApiError(
      "invalid_request",
      "invalid meeting context identity or evidence path",
    );
  if (Buffer.byteLength(JSON.stringify({ request })) > 786_432)
    throw new ApiError(
      "context_too_large",
      "Shorten the brief or reduce selected context before starting. Live context needs 256 KiB of request space.",
    );
  const active = () => {
    const session = requireSession(state.db, account, id);
    if (
      session.state !== "active" ||
      session.lease_expires_ms === null ||
      session.lease_expires_ms <= state.clock()
    )
      throw new ApiError(
        "session_conflict",
        "meeting authorization expired; start again",
      );
  };
  active();
  acquire(state, account);
  try {
    state.db
      .transaction(() =>
        reserveAttempt(
          state.db,
          account,
          "context_check",
          state.clock(),
          60_000n,
          6n,
        ),
      )
      .immediate();
    await checkInput(
      state,
      requestBody(state, advicePrompt(request), contracts.adviceSchema),
      16_000,
      signal,
    );
    active();
    return { ready: true, reservedInputTokens: 8_000 };
  } finally {
    state.aiInFlight.delete(account);
  }
}

export async function recommend(
  state: ServiceState,
  account: bigint,
  id: string,
  body: z.infer<typeof adviceBody>,
  disconnected: AbortSignal,
) {
  state.requireAdmission();
  const key = body.idempotencyKey;
  if (!key || Buffer.byteLength(key) > 128 || body.request.sessionId !== id)
    throw new ApiError("invalid_request", "invalid recommendation identity");
  if (body.request.evidence.some((e) => !safeRelativePath(e.relativePath)))
    throw new ApiError("invalid_request", "evidence paths must be relative");
  acquire(state, account);
  const deadline = AbortSignal.timeout(30_000);
  let signal = AbortSignal.any([deadline, disconnected]);
  let registered = false;
  try {
    await available(state);
    signal.throwIfAborted();
    const now = state.clock();
    state.db
      .transaction(() => {
        state.requireAssistance();
        const session = requireSession(state.db, account, id);
        if (
          session.state !== "active" ||
          session.lease_version !== BigInt(body.leaseVersion) ||
          session.lease_expires_ms === null ||
          session.lease_expires_ms <= now ||
          session.billable_since_ms === null ||
          session.reserved_ms <= 0n ||
          !healthyAudio(state, session.id, now)
        )
          throw new ApiError(
            "session_conflict",
            "resume healthy transcription before requesting advice",
          );
        if (requestState(state.db, account, key) !== undefined)
          throw new ApiError(
            "result_unavailable",
            "request already dispatched",
          );
        const attempts = state.db
          .prepare<
            [bigint, bigint],
            { count: bigint; last: bigint | null; first: bigint | null }
          >(
            "SELECT count(*) AS count,max(created_at_ms) AS last,min(created_at_ms) AS first FROM provider_requests WHERE account_id=? AND operation='advice' AND created_at_ms>?",
          )
          .get(account, now - 3_600_000n)!;
        if (attempts.count >= 120n)
          throw new ApiError(
            "rate_limited",
            "hourly advice limit reached",
            (attempts.first ?? now) + 3_600_000n - now > 0n
              ? (attempts.first ?? now) + 3_600_000n - now
              : 1n,
          );
        if (attempts.last !== null && now - attempts.last < 5000n)
          throw new ApiError(
            "rate_limited",
            "advice delayed",
            5000n - (now - attempts.last),
          );
        state.db
          .prepare(
            "INSERT INTO provider_requests(account_id,request_key,operation,state,deadline_ms,created_at_ms) VALUES(?,?,'advice','pending',?,?)",
          )
          .run(account, key, now + 30_000n, now);
      })
      .immediate();
    const controller = register(state, account, key);
    registered = true;
    signal = AbortSignal.any([signal, controller.signal]);
    try {
      const upstream = requestBody(
        state,
        advicePrompt(body.request),
        contracts.adviceSchema,
      );
      await checkInput(state, upstream, 24_000, signal);
      const advice = validateAdvice(
        await generate(state, upstream, 1024, account, key, signal),
        body.request,
      );
      signal.throwIfAborted();
      state.db
        .transaction(() =>
          completeRequest(
            state,
            account,
            id,
            BigInt(body.leaseVersion),
            key,
            state.clock(),
          ),
        )
        .immediate();
      await recordOutcome(state, false, account);
      return {
        advice,
        sessionId: id,
        generationId: body.request.generationId,
        transcriptRevision: body.request.transcriptRevision,
      };
    } catch (error) {
      const failure = abortFailure(signal, deadline, "advice", error);
      if (
        failure instanceof ApiError &&
        failure.code === "provider_unavailable"
      )
        await recordOutcome(state, true, account);
      throw failure;
    }
  } catch (error) {
    throw error instanceof ApiError
      ? error
      : abortFailure(signal, deadline, "advice", error);
  } finally {
    cleanup(state, account, key, registered);
  }
}
