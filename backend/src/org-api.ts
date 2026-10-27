import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServiceState } from "./state.js";
import { ApiError } from "./errors.js";
import { entityId } from "./funding.js";
import { readObject, send } from "./api.js";
import { reserveAttempt } from "./billing.js";
import {
  acceptInvitation,
  assignSeat,
  createOrganization,
  inviteMember,
  organizationView,
  removeMember,
  requireOwner,
  resendInvitation,
  revokeInvitation,
  transferOwner,
  unassignSeat,
} from "./org.js";
import {
  organizationCheckout,
  organizationPortal,
  updateSeatQuantity,
} from "./org-stripe.js";
import { refreshOrganizationForAccount } from "./org-stripe-events.js";

async function authorizeEither(state: ServiceState, req: IncomingMessage) {
  if (req.headers.authorization !== undefined)
    return state.authorize(req.headers);
  if (
    req.method !== "GET" &&
    req.headers.origin !== new URL(state.config.issuer).origin
  )
    throw new ApiError(
      "invalid_request",
      "team changes require the Savvy page origin",
      undefined,
      403,
    );
  if (
    req.method !== "GET" &&
    !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")
  )
    throw new ApiError(
      "invalid_request",
      "team changes require application/json",
      undefined,
      415,
    );
  if (!state.bindings.authorizeBrowser)
    throw new ApiError("sign_in_required", "sign in to manage your Savvy team");
  return state.bindings.authorizeBrowser(req.headers);
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new ApiError(
      "invalid_request",
      "invalid team request",
      undefined,
      422,
    );
  return result.data;
}
const accountBody = z.object({ accountId: entityId }).strict();
const empty = z.object({}).strict();
function ownOrganization(state: ServiceState, account: bigint) {
  const member = state.db
    .prepare<[bigint], { organization_id: bigint }>(
      "SELECT organization_id FROM organization_members WHERE account_id=?",
    )
    .get(account);
  if (!member)
    throw new ApiError(
      "invalid_request",
      "you do not belong to an organization",
      undefined,
      403,
    );
  return member.organization_id;
}
async function deliverInvitation(
  state: ServiceState,
  account: bigint,
  org: bigint,
  invitation: { id: string; email: string; token: string },
) {
  let deliveryState = "sent";
  try {
    if (!state.bindings.sendInvitation)
      throw new Error("Invitation mail is not configured");
    await state.bindings.sendInvitation(
      invitation.email,
      new URL(`/team/join#${invitation.token}`, state.config.issuer).href,
    );
  } catch {
    deliveryState = "failed";
    console.warn("organization invitation delivery failed");
  }
  state.db
    .prepare(
      "UPDATE organization_invitations SET delivery_state=? WHERE id=? AND token_hash=?",
    )
    .run(
      deliveryState,
      BigInt(invitation.id),
      createHash("sha256").update(invitation.token).digest("hex"),
    );
  requireOwner(state.db, account, org);
  return { invitationId: invitation.id, deliveryState };
}
export async function organizationRequest(
  state: ServiceState,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
) {
  const account = await authorizeEither(state, req),
    actor = account.accountId;
  if (!state.config.billing)
    throw new ApiError(
      "invalid_request",
      "team billing is not enabled",
      undefined,
      403,
    );
  if (path === "/v1/org" && req.method === "GET") {
    await refreshOrganizationForAccount(state, actor);
    send(
      res,
      state.db
        .transaction(() => ({
          ...organizationView(state.db, actor, state.clock()),
          identity: account.displayIdentity,
        }))
        .immediate(),
    );
    return;
  }
  if (req.method !== "POST")
    throw new ApiError("invalid_request", "unknown team route", undefined, 404);
  if (
    path === "/v1/org" ||
    path === "/v1/org/invitations" ||
    /^\/v1\/org\/invitations\/[^/]+\/resend$/.test(path)
  )
    state.requireAdmission();
  const body = await readObject(req);
  state.db
    .transaction(() => {
      reserveAttempt(state.db, actor, "org", state.clock(), 60_000n, 30n);
      if (path === "/v1/org/invitations/accept")
        reserveAttempt(state.db, 0n, "org_accept", state.clock(), 60_000n, 60n);
    })
    .immediate();
  if (path === "/v1/org") {
    const value = parse(
      z.object({ name: z.string().min(1).max(120) }).strict(),
      body,
    );
    const id = state.db
      .transaction(() =>
        createOrganization(
          state.db,
          actor,
          value.name,
          state.clock(),
          account.displayIdentity.email ?? undefined,
        ),
      )
      .immediate();
    send(res, { organizationId: id.toString() });
    return;
  }
  if (path === "/v1/org/invitations/accept") {
    const value = parse(
      z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
      body,
    );
    if (
      !account.displayIdentity.emailVerified ||
      !account.displayIdentity.email
    )
      throw new ApiError(
        "sign_in_required",
        "verify the invited email before joining",
      );
    send(
      res,
      state.db
        .transaction(() =>
          acceptInvitation(
            state.db,
            actor,
            account.displayIdentity.email!,
            value.token,
            state.clock(),
          ),
        )
        .immediate(),
    );
    return;
  }
  const org = ownOrganization(state, actor);
  if (path === "/v1/org/checkout") {
    const value = parse(
      z.union([
        z
          .object({
            quantity: z.number().int().min(1).max(50),
            requestKey: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
          })
          .strict(),
        z.object({ resumeId: entityId }).strict(),
      ]),
      body,
    );
    if ("resumeId" in value) {
      requireOwner(state.db, actor, org);
      const previous = state.db
        .prepare<[bigint, bigint], { quantity: bigint; request_key: string }>(
          "SELECT quantity,request_key FROM organization_checkouts WHERE id=? AND organization_id=?",
        )
        .get(BigInt(value.resumeId), org);
      if (!previous)
        throw new ApiError(
          "invalid_request",
          "purchase attempt does not belong to this organization",
          undefined,
          403,
        );
      send(
        res,
        await organizationCheckout(state, actor, org, {
          quantity: Number(previous.quantity),
          requestKey: previous.request_key,
        }),
      );
    } else send(res, await organizationCheckout(state, actor, org, value));
    return;
  }
  if (path === "/v1/org/seats") {
    const value = parse(
      z
        .object({
          quantity: z.number().int().min(1).max(50),
          retireSeatIds: z.array(entityId).max(50),
          requestKey: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
        })
        .strict(),
      body,
    );
    send(res, await updateSeatQuantity(state, actor, org, value));
    return;
  }
  if (path === "/v1/org/portal") {
    parse(empty, body);
    send(res, await organizationPortal(state, actor, org));
    return;
  }
  if (path === "/v1/org/invitations") {
    const value = parse(
      z
        .object({ email: z.string().max(254), assignSeat: z.boolean() })
        .strict(),
      body,
    );
    const invitation = state.db
      .transaction(() =>
        inviteMember(
          state.db,
          actor,
          org,
          value.email,
          value.assignSeat,
          state.clock(),
        ),
      )
      .immediate();
    send(res, await deliverInvitation(state, actor, org, invitation));
    return;
  }
  const invitation = /^\/v1\/org\/invitations\/([^/]+)\/(resend|revoke)$/.exec(
    path,
  );
  if (invitation) {
    parse(empty, body);
    const id = BigInt(parse(entityId, invitation[1]));
    if (invitation[2] === "resend") {
      const result = state.db
        .transaction(() =>
          resendInvitation(state.db, actor, org, id, state.clock()),
        )
        .immediate();
      send(res, await deliverInvitation(state, actor, org, result));
    } else {
      state.db
        .transaction(() => revokeInvitation(state.db, actor, org, id))
        .immediate();
      send(res, { revoked: true });
    }
    return;
  }
  const seat = /^\/v1\/org\/seats\/([^/]+)\/(assign|unassign)$/.exec(path);
  if (seat) {
    const id = BigInt(parse(entityId, seat[1]));
    if (seat[2] === "assign") {
      const value = parse(accountBody, body);
      send(
        res,
        state.db
          .transaction(() =>
            assignSeat(
              state.db,
              actor,
              org,
              BigInt(value.accountId),
              state.clock(),
              id,
            ),
          )
          .immediate(),
      );
    } else {
      parse(empty, body);
      state.db
        .transaction(() => unassignSeat(state, actor, org, id, state.clock()))
        .immediate()();
      send(res, { unassigned: true });
    }
    return;
  }
  const removal = /^\/v1\/org\/members\/([^/]+)\/remove$/.exec(path);
  if (removal) {
    parse(empty, body);
    const id = BigInt(parse(entityId, removal[1]));
    state.db
      .transaction(() => removeMember(state, actor, org, id, state.clock()))
      .immediate()();
    send(res, { removed: true });
    return;
  }
  if (path === "/v1/org/leave") {
    parse(empty, body);
    state.db
      .transaction(() => removeMember(state, actor, org, actor, state.clock()))
      .immediate()();
    send(res, { left: true });
    return;
  }
  if (path === "/v1/org/transfer-owner") {
    const value = parse(accountBody, body);
    state.db
      .transaction(() =>
        transferOwner(state.db, actor, org, BigInt(value.accountId)),
      )
      .immediate();
    send(res, { transferred: true });
    return;
  }
  throw new ApiError("invalid_request", "unknown team route", undefined, 404);
}
