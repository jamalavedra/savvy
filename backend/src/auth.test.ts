import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, copyFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, createPublicKey, verify } from "node:crypto";
import { SMTPServer } from "smtp-server";
import { createAuth } from "./auth.js";
import { migrate } from "./migrate.js";
import { backupDatabases } from "./backup.js";
import { openServiceDatabase } from "./db.js";
import {
  insertGrant,
  accountSummary,
  reserveAttempt,
  reserveBrief,
  settleBriefSuccess,
} from "./billing.js";
import { createAuthorizer } from "./authorize.js";

test("real Better Auth: delivered OTP, persistent limits, discovery, PKCE and signing keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "savvy-auth-"));
  let message = "";
  const smtp = new SMTPServer({
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, _session, done) {
      message = "";
      stream.on("data", (chunk) => {
        message += chunk.toString();
      });
      stream.on("end", done);
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const address = smtp.server.address() as { port: number };
  const env = {
    BETTER_AUTH_URL: "http://127.0.0.1:8788",
    BETTER_AUTH_SECRET: "test-only-secret-that-is-over-32-characters",
    SAVVY_AUTH_DATABASE: join(directory, "auth.sqlite"),
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(address.port),
    SMTP_FROM: "Savvy <auth@example.test>",
  };
  const instance = createAuth(env);
  try {
    await migrate(instance);
    const request = (path: string, body?: unknown) =>
      instance.auth.handler(
        new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            "content-type": "application/json",
            origin: env.BETTER_AUTH_URL,
            "x-savvy-client-ip": "127.0.0.1",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const discovery = await instance.auth.handler(
      new Request(env.BETTER_AUTH_URL + "/.well-known/openid-configuration"),
    );
    assert.equal(discovery.status, 200);
    const metadata = await discovery.json();
    assert.deepEqual(metadata.grant_types_supported.sort(), [
      "authorization_code",
      "refresh_token",
    ]);
    assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
    const sent = await request("/email-otp/send-verification-otp", {
      email: "person@example.test",
      type: "sign-in",
    });
    assert.equal(sent.status, 200, await sent.text());
    const otp = message.match(/code is (\d{6})/)?.[1];
    assert.ok(otp, message);
    const stored = instance.db
      .prepare("SELECT value FROM verification")
      .all() as { value: string }[];
    assert.ok(stored.every((row) => !row.value.includes(otp)));
    assert.ok(
      stored.every(
        (row) =>
          !row.value.includes(
            createHash("sha256").update(otp).digest("base64url"),
          ),
      ),
    );
    assert.ok(stored.some((row) => row.value.startsWith("v1-")));
    const otherSecret = createAuth({
      ...env,
      SAVVY_AUTH_DATABASE: ":memory:",
      BETTER_AUTH_SECRET: "another-test-only-secret-over-32-characters",
    });
    assert.notEqual(
      await instance.hashOTP("000001"),
      await otherSecret.hashOTP("000001"),
    );
    otherSecret.db.close();
    for (const path of [
      "/email-otp/request-password-reset",
      "/forget-password/email-otp",
      "/email-otp/request-email-change",
      "/email-otp/verify-email",
    ]) {
      assert.notEqual(
        (
          await request(path, {
            email: "person@example.test",
            newEmail: "other@example.test",
            otp,
          })
        ).status,
        200,
      );
    }
    assert.equal(message.match(/code is (\d{6})/)?.[1], otp);
    const limited = await request("/email-otp/send-verification-otp", {
      email: "PERSON@example.test",
      type: "sign-in",
    });
    assert.equal(limited.status, 429);
    const second = createAuth(env);
    assert.throws(() =>
      second.reserveDelivery("person@example.test", Date.now()),
    );
    second.db.close();
    const signed = await request("/sign-in/email-otp", {
      email: "person@example.test",
      otp,
    });
    assert.equal(signed.status, 200, await signed.text());
    const cookie = signed.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const session = await instance.auth.handler(
      new Request(env.BETTER_AUTH_URL + "/api/auth/get-session", {
        headers: { cookie },
      }),
    );
    assert.equal(session.status, 200);
    assert.ok(
      (await session.json())?.session,
      "admin checks need a valid session",
    );
    const resourcePath = `/admin/oauth2/resources/${encodeURIComponent(instance.audience)}`;
    for (const path of [
      "/admin/oauth2/resources",
      resourcePath,
      `${resourcePath}/clients/${instance.clientId}`,
    ]) {
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
        const response = await instance.auth.handler(
          new Request(env.BETTER_AUTH_URL + "/api/auth" + path, {
            method,
            headers: {
              cookie,
              "content-type": "application/json",
              origin: env.BETTER_AUTH_URL,
            },
            ...(method === "GET"
              ? {}
              : {
                  body: JSON.stringify({
                    identifier: "https://unauthorized.example.test",
                    disabled: true,
                  }),
                }),
          }),
        );
        assert.equal(
          response.status,
          404,
          `resource administration must be absent from HTTP routing: ${method} ${path}`,
        );
      }
    }
    const verifier = randomBytes(32).toString("base64url");
    const authorize = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      client_id: instance.clientId,
      response_type: "code",
      redirect_uri: "com.alamaslabs.savvy:/oauth/callback",
      scope: "openid email profile offline_access",
      resource: "https://api.savvycopilot.com",
      state: "native-state",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }))
      authorize.searchParams.set(key, value);
    const authorized = await instance.auth.handler(
      new Request(authorize, {
        headers: {
          cookie,
          accept: "text/html",
          "x-savvy-client-ip": "127.0.0.1",
        },
      }),
    );
    assert.equal(authorized.status, 302, await authorized.text());
    const callback = new URL(authorized.headers.get("location")!);
    assert.equal(callback.searchParams.get("state"), "native-state");
    assert.equal(callback.searchParams.get("iss"), metadata.issuer);
    assert.ok(callback.searchParams.get("code"), callback.href);
    const tokenRequest = (body: Record<string, string>) =>
      instance.auth.handler(
        new Request(metadata.token_endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-savvy-client-ip": "127.0.0.1",
          },
          body: new URLSearchParams(body),
        }),
      );
    const exchangeBody = {
      grant_type: "authorization_code",
      client_id: instance.clientId,
      code: callback.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: "com.alamaslabs.savvy:/oauth/callback",
    };
    const exchange = await tokenRequest(exchangeBody);
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const tokens = await exchange.json();
    assert.ok(tokens.refresh_token);
    const [header, payload, signature] = tokens.access_token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(claims.iss, metadata.issuer);
    assert.ok([claims.aud].flat().includes("https://api.savvycopilot.com"));
    const publicKeys = await (await request("/jwks")).json();
    assert.ok(
      verify(
        "RSA-SHA256",
        Buffer.from(header + "." + payload),
        createPublicKey({ key: publicKeys.keys[0], format: "jwk" }),
        Buffer.from(signature, "base64url"),
      ),
    );
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      client_id: instance.clientId,
      refresh_token: tokens.refresh_token,
    });
    assert.equal(refresh.status, 200);
    const refreshed = await refresh.json();
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
    const servicePath = join(directory, "service.sqlite");
    const ledger = openServiceDatabase(servicePath);
    try {
      const now = BigInt(Date.now());
      ledger
        .prepare(
          "INSERT INTO accounts(id,issuer,subject,stripe_customer_id,created_at_ms) VALUES(1,?,?,'cus_backup',?)",
        )
        .run(env.BETTER_AUTH_URL, claims.sub, now);
      ledger
        .transaction(() => {
          insertGrant(
            ledger,
            1n,
            "old_paid_pack",
            "pack",
            7_200_000n,
            4n,
            now,
            null,
          );
          reserveBrief(ledger, 1n, "paid_brief", now);
          settleBriefSuccess(ledger, 1n, "paid_brief", now);
          for (let i = 0; i < 6; i++)
            reserveAttempt(ledger, 1n, "brief", now, 60_000n, 6n);
        })
        .immediate();
      ledger
        .prepare(
          "INSERT INTO checkouts(account_id,request_key,product,state,stripe_id,created_at_ms) VALUES(1,'pending_identity','pack','pending','cs_backup',?)",
        )
        .run(now);
      const before = accountSummary(ledger, 1n, now);
      const snapshot = join(directory, "coordinated-backup");
      const manifest = await backupDatabases(
        { auth: env.SAVVY_AUTH_DATABASE, service: servicePath },
        snapshot,
      );
      assert.deepEqual(
        manifest.signingKeyIds,
        publicKeys.keys.map((key: { kid: string }) => key.kid).sort(),
      );
      assert.equal(
        JSON.stringify(manifest).includes(env.BETTER_AUTH_SECRET),
        false,
      );
      assert.equal((await stat(snapshot)).mode & 0o777, 0o700);
      const restoreDir = join(directory, "restored");
      await mkdir(restoreDir, { mode: 0o700 });
      for (const file of manifest.files) {
        const source = join(snapshot, file.file);
        assert.equal(
          createHash("sha256")
            .update(await readFile(source))
            .digest("hex"),
          file.sha256,
        );
        assert.equal((await stat(source)).mode & 0o777, 0o600);
        await copyFile(source, join(restoreDir, file.file));
      }
      const restored = createAuth({
        ...env,
        SAVVY_AUTH_DATABASE: join(restoreDir, "auth.sqlite"),
      });
      const restoredLedger = openServiceDatabase(
        join(restoreDir, "service.sqlite"),
      );
      try {
        await migrate(restored);
        assert.deepEqual(
          await (
            await restored.auth.handler(
              new Request(env.BETTER_AUTH_URL + "/api/auth/jwks"),
            )
          ).json(),
          publicKeys,
        );
        const renewed = await restored.auth.handler(
          new Request(metadata.token_endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-savvy-client-ip": "127.0.0.1",
            },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: instance.clientId,
              refresh_token: refreshed.refresh_token,
            }),
          }),
        );
        assert.equal(renewed.status, 200);
        const renewedTokens = await renewed.json();
        assert.notEqual(renewedTokens.refresh_token, refreshed.refresh_token);
        const authorize = createAuthorizer(
          restoredLedger,
          {
            issuer: env.BETTER_AUTH_URL,
            audience: instance.audience,
            unmetered: false,
          },
          () => restored.auth.api.getJwks(),
          () => now,
        );
        assert.equal(
          (
            await authorize({
              authorization: `Bearer ${renewedTokens.access_token}`,
            })
          ).accountId,
          1n,
        );
        assert.deepEqual(accountSummary(restoredLedger, 1n, now), before);
        assert.deepEqual(
          restoredLedger
            .prepare("SELECT * FROM usage_events ORDER BY id")
            .all(),
          ledger.prepare("SELECT * FROM usage_events ORDER BY id").all(),
        );
        assert.throws(
          () =>
            restoredLedger
              .transaction(() =>
                reserveAttempt(restoredLedger, 1n, "brief", now, 60_000n, 6n),
              )
              .immediate(),
          { code: "rate_limited" },
        );
      } finally {
        restored.db.close();
        restoredLedger.close();
      }
    } finally {
      ledger.close();
    }

    const revoke = await instance.auth.handler(
      new Request(metadata.revocation_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-savvy-client-ip": "127.0.0.1",
        },
        body: new URLSearchParams({
          client_id: instance.clientId,
          token: refreshed.refresh_token,
          token_type_hint: "refresh_token",
        }),
      }),
    );
    assert.equal(revoke.status, 200);
    const sessionAfterLogout = await instance.auth.handler(
      new Request(env.BETTER_AUTH_URL + "/api/auth/get-session", {
        headers: { cookie },
      }),
    );
    assert.equal(await sessionAfterLogout.json(), null);
    assert.notEqual(
      (
        await tokenRequest({
          grant_type: "refresh_token",
          client_id: instance.clientId,
          refresh_token: refreshed.refresh_token,
        })
      ).status,
      200,
    );
    assert.notEqual((await tokenRequest(exchangeBody)).status, 200);
    const replay = await request("/sign-in/email-otp", {
      email: "person@example.test",
      otp,
    });
    assert.notEqual(replay.status, 200);
    // Exercise expiry and attempt exhaustion through real plugin endpoints.
    instance.db.prepare("DELETE FROM rateLimit").run();
    const expiredSend = await request("/email-otp/send-verification-otp", {
      email: "expired@example.test",
      type: "sign-in",
    });
    assert.equal(expiredSend.status, 200);
    const expiredCode = message.match(/code is (\d{6})/)?.[1];
    assert.ok(expiredCode);
    instance.db
      .prepare(
        "UPDATE verification SET expiresAt = ? WHERE identifier LIKE '%expired@example.test%'",
      )
      .run(Date.now() - 1);
    assert.notEqual(
      (
        await request("/sign-in/email-otp", {
          email: "expired@example.test",
          otp: expiredCode,
        })
      ).status,
      200,
    );
    instance.db.prepare("DELETE FROM rateLimit").run();
    const attemptsSend = await request("/email-otp/send-verification-otp", {
      email: "attempts@example.test",
      type: "sign-in",
    });
    assert.equal(attemptsSend.status, 200);
    const attemptsCode = message.match(/code is (\d{6})/)?.[1];
    assert.ok(attemptsCode);
    for (let i = 0; i < 3; i++)
      assert.notEqual(
        (
          await request("/sign-in/email-otp", {
            email: "attempts@example.test",
            otp: attemptsCode === "000000" ? "111111" : "000000",
          })
        ).status,
        200,
      );
    assert.notEqual(
      (
        await request("/sign-in/email-otp", {
          email: "attempts@example.test",
          otp: attemptsCode,
        })
      ).status,
      200,
    );
    instance.db.prepare("UPDATE otp_delivery_limit SET last_ms = 0").run();
    assert.equal(
      (
        await request("/email-otp/send-verification-otp", {
          email: "attempts@example.test",
          type: "sign-in",
        })
      ).status,
      200,
    );
    const rotatedCode = message.match(/code is (\d{6})/)?.[1];
    assert.ok(rotatedCode);
    assert.equal(
      (
        await request("/sign-in/email-otp", {
          email: "attempts@example.test",
          otp: rotatedCode,
        })
      ).status,
      200,
    );
    const keys = await (await request("/jwks")).json();
    assert.equal(keys.keys[0].alg, "RS256");
    assert.equal(keys.keys[0].kty, "RSA");
    assert.equal(keys.keys[0].d, undefined);
    const registration = await request("/oauth2/register", {
      redirect_uris: ["https://evil.example/callback"],
    });
    assert.notEqual(registration.status, 200);
  } finally {
    instance.db.close();
    await new Promise<void>((resolve) => smtp.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
