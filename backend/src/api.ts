import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServiceState } from "./state.js";
import { available } from "./ai.js";
import {
  briefBody,
  adviceBody,
  postBrief,
  recommend,
  cancelRequest,
  checkMeetingContext,
} from "./advice.js";
import { adviceRequest } from "./context.js";
import { ApiError, json } from "./errors.js";
import { accountSummary, grantFixture } from "./billing.js";
import { checkout, portal, webhook, refreshRenewal } from "./stripe.js";
import {
  validateSessionId,
  createSession,
  sessionView,
  lifecycle,
} from "./sessions.js";

export async function readBody(
  req: IncomingMessage,
  limit = 1_048_576,
): Promise<Buffer> {
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new ApiError(
      "context_too_large",
      "request body exceeds the service limit",
    );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit)
      throw new ApiError(
        "context_too_large",
        "request body exceeds the service limit",
      );
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

export async function readObject(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (
    !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(
      req.headers["content-type"] ?? "",
    )
  )
    throw new ApiError(
      "invalid_request",
      "expected application/json",
      undefined,
      415,
    );
  let value: unknown;
  const raw = await readBody(req);
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new ApiError("invalid_request", "invalid JSON body");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(
      "invalid_request",
      "expected a JSON object",
      undefined,
      422,
    );
  return value as Record<string, unknown>;
}

export function send(res: ServerResponse, value: unknown, status = 200) {
  // Serialize before committing headers so integer overflow returns an error.
  const body = json(value);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError("invalid_request", "invalid request path");
  }
}

async function sendAi(
  res: ServerResponse,
  operation: (signal: AbortSignal) => Promise<unknown>,
) {
  const disconnected = new AbortController();
  const close = () => {
    if (!res.writableEnded) disconnected.abort();
  };
  res.once("close", close);
  if (res.destroyed) disconnected.abort();
  try {
    const result = await operation(disconnected.signal);
    if (!res.destroyed) send(res, result);
  } finally {
    res.off("close", close);
  }
}

export async function managedRequest(
  state: ServiceState,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
) {
  try {
    if (path.startsWith("/v1/billing/") && !state.config.billing)
      throw new ApiError(
        "invalid_request",
        "billing is not configured on this backend",
      );
    if (path === "/v1/briefs" && req.method === "POST") {
      const body = briefBody.safeParse(await readObject(req));
      if (!body.success)
        throw new ApiError(
          "invalid_request",
          "invalid brief request",
          undefined,
          422,
        );
      const account = await state.authorize(req.headers);
      await sendAi(res, (signal) =>
        postBrief(state, account.accountId, body.data, signal),
      );
      return;
    }
    const contextCheck = /^\/v1\/sessions\/([^/]+)\/context$/.exec(path);
    if (contextCheck && req.method === "POST") {
      const account = await state.authorize(req.headers);
      const body = await readObject(req);
      const request = adviceRequest.safeParse(body.request);
      if (!request.success)
        throw new ApiError(
          "invalid_request",
          "invalid meeting context",
          undefined,
          422,
        );
      await sendAi(res, (signal) =>
        checkMeetingContext(
          state,
          account.accountId,
          decodeSegment(contextCheck[1]),
          request.data,
          signal,
        ),
      );
      return;
    }
    const recommendation = /^\/v1\/sessions\/([^/]+)\/recommendations$/.exec(
      path,
    );
    if (recommendation && req.method === "POST") {
      const body = adviceBody.safeParse(await readObject(req));
      if (!body.success)
        throw new ApiError(
          "invalid_request",
          "invalid advice request",
          undefined,
          422,
        );
      const account = await state.authorize(req.headers);
      await sendAi(res, (signal) =>
        recommend(
          state,
          account.accountId,
          decodeSegment(recommendation[1]),
          body.data,
          signal,
        ),
      );
      return;
    }
    const cancellation = /^\/v1\/requests\/([^/]+)\/cancel$/.exec(path);
    if (cancellation && req.method === "POST") {
      const account = await state.authorize(req.headers);
      send(
        res,
        cancelRequest(state, account.accountId, decodeSegment(cancellation[1])),
      );
      return;
    }
    if (path === "/v1/sessions" && req.method === "POST") {
      const body = await readObject(req);
      if (typeof body.sessionId !== "string")
        throw new ApiError(
          "invalid_request",
          "sessionId must be a string",
          undefined,
          422,
        );
      const account = await state.authorize(req.headers);
      const id = validateSessionId(body.sessionId);
      const existing = state.db
        .prepare(
          "SELECT 1 FROM managed_sessions WHERE account_id=? AND local_session_id=?",
        )
        .get(account.accountId, id);
      if (!existing) {
        state.requireAdmission();
        await available(state);
        await refreshRenewal(state, account.accountId);
      }
      send(
        res,
        state.db
          .transaction(() => {
            if (!existing) state.requireAssistance();
            createSession(state.db, account.accountId, id, state.clock());
            return sessionView(state.db, account.accountId, id, state.clock());
          })
          .immediate(),
      );
      return;
    }
    const sessionAction = /^\/v1\/sessions\/([^/]+)\/(pause|resume|stop)$/.exec(
      path,
    );
    if (sessionAction && req.method === "POST") {
      const body = await readObject(req);
      if (
        typeof body.leaseVersion !== "number" ||
        !Number.isSafeInteger(body.leaseVersion) ||
        typeof body.commandId !== "number" ||
        !Number.isSafeInteger(body.commandId) ||
        Object.keys(body).some(
          (key) => !["leaseVersion", "commandId"].includes(key),
        )
      )
        throw new ApiError(
          "invalid_request",
          "invalid lifecycle request",
          undefined,
          422,
        );
      const account = await state.authorize(req.headers);
      const action = sessionAction[2] as "pause" | "resume" | "stop";
      if (action === "resume") {
        state.requireAdmission();
        await available(state);
        await refreshRenewal(state, account.accountId);
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(sessionAction[1]);
      } catch {
        throw new ApiError("invalid_request", "sessionId must be a UUID");
      }
      send(
        res,
        lifecycle(
          state,
          account.accountId,
          validateSessionId(decoded),
          action,
          BigInt(body.leaseVersion),
          BigInt(body.commandId),
        ),
      );
      return;
    }
    if (path === "/v1/billing/webhook" && req.method === "POST") {
      const header = req.headers["stripe-signature"];
      send(
        res,
        await webhook(
          state,
          typeof header === "string" ? header : "",
          await readBody(req),
        ),
      );
      return;
    }
    if (path === "/v1/billing/checkout" && req.method === "POST") {
      const body = await readObject(req);
      if (
        typeof body.product !== "string" ||
        typeof body.idempotencyKey !== "string" ||
        Object.keys(body).some(
          (key) => !["product", "idempotencyKey"].includes(key),
        )
      )
        throw new ApiError(
          "invalid_request",
          "invalid checkout request",
          undefined,
          422,
        );
      state.requireAdmission();
      const account = await state.authorize(req.headers);
      send(
        res,
        await checkout(state, account.accountId, {
          product: body.product,
          idempotencyKey: body.idempotencyKey,
        }),
      );
      return;
    }
    if (path === "/v1/billing/portal" && req.method === "POST") {
      const account = await state.authorize(req.headers);
      send(res, await portal(state, account.accountId));
      return;
    }
    if (path === "/readyz" && req.method === "GET") {
      state.requireAdmission();
      state.db.prepare("SELECT COUNT(*) FROM accounts").get();
      res.writeHead(204).end();
      return;
    }
    if (path === "/v1/account" && req.method === "GET") {
      const account = await state.authorize(req.headers);
      await refreshRenewal(state, account.accountId);
      const summary = state.db
        .transaction(() =>
          accountSummary(
            state.db,
            account.accountId,
            state.clock(),
            state.config.billing !== null,
          ),
        )
        .immediate();
      send(res, {
        ...summary,
        identity: account.displayIdentity,
        purchaseAvailability: {
          monthly: !state.draining,
          pack: !state.draining,
        },
      });
      return;
    }
    if (
      path === "/v1/dev/grant" &&
      state.config.fixtures &&
      req.method === "POST"
    ) {
      const body = await readObject(req);
      if (typeof body.kind !== "string")
        throw new ApiError(
          "invalid_request",
          "kind must be a string",
          undefined,
          422,
        );
      const account = await state.authorize(req.headers);
      const now = state.clock();
      const summary = state.db
        .transaction(() => {
          grantFixture(state.db, account.accountId, body.kind as string, now);
          return accountSummary(
            state.db,
            account.accountId,
            now,
            state.config.billing !== null,
          );
        })
        .immediate();
      send(res, summary);
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    const failure =
      error instanceof ApiError
        ? error
        : new ApiError("internal", "the service hit an internal error");
    if (failure.status === 413) res.setHeader("Connection", "close");
    if (!res.destroyed && !res.headersSent) send(res, failure, failure.status);
  }
}
