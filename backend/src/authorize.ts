import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import type { IncomingHttpHeaders } from "node:http";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { insertGrant, MS_PER_HOUR } from "./billing.js";

export function createAuthorizer(
  db: Db,
  {
    issuer,
    audience,
    unmetered,
  }: { issuer: string; audience: string; unmetered: boolean },
  getKeys: () => Promise<JSONWebKeySet>,
  clock: () => bigint,
) {
  return async (headers: IncomingHttpHeaders) => {
    const authorization = headers.authorization;
    if (!authorization?.startsWith("Bearer "))
      throw new ApiError(
        "sign_in_required",
        "this request needs a Savvy account token",
      );
    const token = authorization.slice(7).trim();
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new ApiError("sign_in_required", "the access token is malformed");
    }
    if (header.alg !== "RS256")
      throw new ApiError(
        "sign_in_required",
        "the access token uses an unsupported algorithm",
      );
    if (!header.kid)
      throw new ApiError(
        "sign_in_required",
        "the access token names no signing key",
      );
    // The provider is local Better Auth, not a caller-selected network endpoint.
    // Read its current public set so key removal and rotation take effect directly.
    let keys;
    try {
      keys = await getKeys();
    } catch (error) {
      console.error("identity signing keys unavailable", error);
      throw new ApiError(
        "provider_unavailable",
        "identity signing keys unavailable",
      );
    }
    if (
      !keys.keys.some(
        (key) =>
          key.kid === header.kid &&
          key.kty === "RSA" &&
          (!key.alg || key.alg === "RS256"),
      )
    )
      throw new ApiError(
        "sign_in_required",
        "the access token references an unknown signing key",
      );
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, createLocalJWKSet(keys), {
        algorithms: ["RS256"],
        issuer,
        audience,
        requiredClaims: ["exp", "sub", "iss", "aud"],
        clockTolerance: 0,
      }));
    } catch {
      throw new ApiError(
        "sign_in_required",
        "the access token is invalid or expired",
      );
    }
    if (
      typeof claims.sub !== "string" ||
      !claims.sub.trim() ||
      Buffer.byteLength(claims.sub) > 256 ||
      !Number.isSafeInteger(claims.exp) ||
      !Number.isSafeInteger(claims.exp! * 1000)
    )
      throw new ApiError("sign_in_required", "invalid account subject");
    if (
      (claims.name != null && typeof claims.name !== "string") ||
      (claims.email != null && typeof claims.email !== "string") ||
      (claims.email_verified != null &&
        typeof claims.email_verified !== "boolean")
    )
      throw new ApiError(
        "sign_in_required",
        "the access token is invalid or expired",
      );
    const row = db
      .transaction(() => {
        db.prepare(
          "INSERT OR IGNORE INTO accounts(issuer,subject,disabled,created_at_ms) VALUES(?,?,0,?)",
        ).run(issuer, claims.sub, clock());
        const account = db
          .prepare<[string, string], { id: bigint; disabled: bigint }>(
            "SELECT id,disabled FROM accounts WHERE issuer=? AND subject=?",
          )
          .get(issuer, claims.sub!)!;
        // ponytail: one unbounded grant per account; startup revokes it while Stripe is set.
        if (unmetered)
          insertGrant(
            db,
            account.id,
            `unmetered:${account.id}`,
            "unmetered",
            1_000_000n * MS_PER_HOUR,
            1_000_000n,
            clock(),
            null,
          );
        return account;
      })
      .immediate();
    if (row.disabled !== 0n)
      throw new ApiError(
        "sign_in_required",
        "this Savvy account is disabled; contact support",
        undefined,
        403,
      );
    return {
      accountId: row.id,
      subject: claims.sub,
      expiresAtMs: BigInt(claims.exp!) * 1000n,
      displayIdentity: {
        issuer,
        subject: claims.sub,
        name: claims.name ?? null,
        email: claims.email_verified === true ? (claims.email ?? null) : null,
        emailVerified: claims.email_verified === true,
      },
    };
  };
}

export type Authorizer = ReturnType<typeof createAuthorizer>;
