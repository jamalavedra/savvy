import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { SMTPServer } from "smtp-server";
import { createAuth } from "./auth.js";
import { migrate } from "./migrate.js";
import { createAuthorizer, createBrowserAuthorizer } from "./authorize.js";
import { openServiceDatabase } from "./db.js";
import { configuration } from "./config.js";
import { ServiceState } from "./state.js";
import { managedRequest } from "./api.js";
import { insertGrant } from "./billing.js";
import { setCapability, disableTeamPurchases } from "./capability.js";

type Identity = { cookie: string; token: string; id: bigint; subject: string };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "savvy-org-routes-"));
  const messages: { to: string; raw: string }[] = [];
  const smtp = new SMTPServer({
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, session, done) {
      let raw = "";
      stream.on("data", (chunk) => {
        raw += chunk.toString();
      });
      stream.on("end", () => {
        messages.push({ to: session.envelope.rcptTo[0].address, raw });
        done();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const smtpAddress = smtp.server.address();
  assert.ok(smtpAddress && typeof smtpAddress !== "string");
  const server = createServer(
    (req, res) =>
      void managedRequest(
        state,
        req,
        res,
        new URL(req.url!, "http://fixture").pathname,
      ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const env = {
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: "test-secret-that-is-longer-than-thirty-two-characters",
    SAVVY_AUTH_DATABASE: join(directory, "auth.sqlite"),
    SAVVY_DB_PATH: join(directory, "service.sqlite"),
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtpAddress.port),
    SMTP_FROM: "Savvy <auth@example.test>",
    SAVVY_STRIPE_SECRET_KEY: "synthetic",
    SAVVY_STRIPE_WEBHOOK_SECRET: "synthetic",
    SAVVY_STRIPE_PRICE_MONTHLY: "price_monthly",
    SAVVY_STRIPE_PRICE_PACK: "price_pack",
    SAVVY_ANTHROPIC_API_KEY: "synthetic",
    SAVVY_DEEPGRAM_API_KEY: "synthetic",
  };
  const instance = createAuth(env);
  await migrate(instance);
  const db = openServiceDatabase(env.SAVVY_DB_PATH),
    clock = () => BigInt(Date.now()),
    config = configuration(env);
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "fixture", alg: "RS256" };
  const links: { email: string; link: string }[] = [];
  let failMail = false;
  const state = new ServiceState(
    config,
    db,
    clock,
    createAuthorizer(
      db,
      { issuer: base, audience: config.audience, unmetered: false },
      async () => ({ keys: [jwk] }),
      clock,
    ),
    {
      authorizeBrowser: createBrowserAuthorizer(
        db,
        { issuer: base, unmetered: false },
        (headers) => instance.auth.api.getSession({ headers }),
        clock,
      ),
      sendInvitation: async (email, link) => {
        links.push({ email, link });
        if (failMail) throw new Error(`fixture delivery failed ${link}`);
        await instance.mail.sendMail({
          from: env.SMTP_FROM,
          to: email,
          subject: "Join your Savvy team",
          text: `Join your team: ${link}`,
        });
      },
    },
  );
  const tx = <T>(fn: () => T) => db.transaction(fn).immediate();
  tx(() => setCapability(db, "team_purchase_enabled", "1", clock()));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => smtp.close(() => r()));
    instance.mail.close();
    instance.db.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function request(
    path: string,
    identity?: Identity,
    body?: unknown,
    options: {
      bearer?: boolean;
      origin?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers: Record<string, string> = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(identity
        ? options.bearer
          ? { authorization: `Bearer ${identity.token}` }
          : { cookie: identity.cookie }
        : {}),
      ...options.headers,
    };
    if (body !== undefined && options.origin !== null)
      headers.origin = options.origin ?? base;
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function login(email: string): Promise<Identity> {
    const authRequest = (path: string, body: unknown) =>
      instance.auth.handler(
        new Request(base + "/api/auth" + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: base,
            "x-savvy-client-ip": "127.0.0.1",
          },
          body: JSON.stringify(body),
        }),
      );
    assert.equal(
      (
        await authRequest("/email-otp/send-verification-otp", {
          email,
          type: "sign-in",
        })
      ).status,
      200,
    );
    const otp = messages
      .slice()
      .reverse()
      .find((m) => m.to === email)!
      .raw.match(/code is (\d{6})/)?.[1];
    assert.ok(otp);
    const signed = await authRequest("/sign-in/email-otp", { email, otp });
    assert.equal(signed.status, 200);
    const cookie = signed.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const session = await instance.auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    assert.ok(session?.user.emailVerified);
    const subject = session.user.id;
    const token = await new SignJWT({ email, email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setSubject(subject)
      .setIssuer(base)
      .setAudience(config.audience)
      .setExpirationTime("10m")
      .sign(privateKey);
    const identity = { cookie, token, subject, id: 0n };
    assert.equal((await request("/v1/org", identity)).status, 200);
    identity.id = db
      .prepare<[string], { id: bigint }>(
        "SELECT id FROM accounts WHERE subject=?",
      )
      .get(subject)!.id;
    return identity;
  }
  return {
    db,
    state,
    base,
    tx,
    clock,
    links,
    messages,
    login,
    request,
    failMail: (value: boolean) => {
      failMail = value;
    },
  };
}

test("real OTP cookies and signed bearer resolve one account; team CSRF and private endpoints fail closed", async (t) => {
  const h = await fixture(t),
    owner = await h.login("owner@example.test");
  const empty = await h.request("/v1/org", owner);
  assert.equal(empty.body.organization, null);
  assert.equal(empty.body.catalog.monthly.amountCents, 7900);
  assert.equal(
    (await h.request("/v1/org", owner, undefined, { bearer: true })).status,
    200,
  );
  assert.equal(
    h.db.prepare<[], { n: bigint }>("SELECT count(*) AS n FROM accounts").get()!
      .n,
    1n,
  );
  assert.equal((await h.request("/v1/org")).status, 401);
  assert.equal(
    (await h.request("/v1/org", owner, { name: "Team" }, { origin: null }))
      .status,
    403,
  );
  assert.equal(
    (
      await h.request(
        "/v1/org",
        owner,
        { name: "Team" },
        { origin: "https://foreign.test" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await h.request("/v1/org", owner, undefined, {
        headers: { authorization: "Bearer invalid" },
      })
    ).status,
    401,
  );
  assert.equal((await h.request("/v1/account", owner)).status, 401);
  assert.equal((await h.request("/v1/sources/connections", owner)).status, 401);
  assert.equal(
    (await h.request("/v1/sessions", owner, { sessionId: randomUUID() }))
      .status,
    401,
  );
  assert.equal(
    (await h.request("/v1/org", owner, { name: "Team" })).status,
    200,
  );
  h.db.prepare("UPDATE accounts SET disabled=1 WHERE id=?").run(owner.id);
  assert.equal((await h.request("/v1/org", owner)).status, 403);
  assert.equal(
    (await h.request("/v1/org", owner, undefined, { bearer: true })).status,
    403,
  );
});

test("delivered invitations bind verified email, survive acquisition off and hide tokens from views and failures", async (t) => {
  const h = await fixture(t),
    owner = await h.login("owner@example.test"),
    member = await h.login("member@example.test"),
    wrong = await h.login("wrong@example.test");
  await h.request("/v1/org", owner, { name: "Team" });
  const invited = await h.request("/v1/org/invitations", owner, {
    email: "member@example.test",
    assignSeat: true,
  });
  assert.equal(invited.status, 200);
  assert.equal(invited.body.deliveryState, "sent");
  assert.equal(
    h.messages.some(
      (m) =>
        m.to === "member@example.test" && /Join your Savvy team/.test(m.raw),
    ),
    true,
  );
  const token = new URL(h.links[0].link).hash.slice(1);
  assert.equal(JSON.stringify(invited.body).includes(token), false);
  assert.equal(
    (await h.request("/v1/org/invitations/accept", wrong, { token })).status,
    400,
  );
  disableTeamPurchases(h.db, h.clock());
  const joined = await h.request("/v1/org/invitations/accept", member, {
    token,
  });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.seat, false);
  assert.equal(
    (await h.request("/v1/org/invitations/accept", member, { token })).status,
    400,
  );
  assert.equal(
    (
      await h.request("/v1/org/invitations", owner, {
        email: "new@example.test",
        assignSeat: false,
      })
    ).body.code,
    "team_purchase_disabled",
  );
  assert.equal(
    (
      await h.request("/v1/org/invitations", member, {
        email: "new@example.test",
        assignSeat: false,
      })
    ).status,
    403,
  );
  assert.equal((await h.request("/v1/org/portal", member, {})).status, 403);
  const view = await h.request("/v1/org", member);
  assert.equal(JSON.stringify(view.body).includes("owner@example.test"), false);
  assert.equal(JSON.stringify(view.body).includes(token), false);
  h.tx(() => setCapability(h.db, "team_purchase_enabled", "1", h.clock()));
  h.failMail(true);
  const logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    logs.push(args);
  });
  const failed = await h.request("/v1/org/invitations", owner, {
    email: "delivery@example.test",
    assignSeat: false,
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.deliveryState, "failed");
  assert.equal(
    h.db
      .prepare<[], { n: bigint }>(
        "SELECT count(*) AS n FROM organization_invitations WHERE delivery_state='failed'",
      )
      .get()!.n,
    1n,
  );
  assert.equal(JSON.stringify(logs).includes("delivery@example.test"), false);
  assert.equal(JSON.stringify(logs).includes(h.links.at(-1)!.link), false);
});

test("explicit seat assignment and concurrent member sessions preserve personal billing and foreign-ID isolation", async (t) => {
  const h = await fixture(t),
    owner = await h.login("owner@example.test"),
    member = await h.login("member@example.test"),
    outsider = await h.login("outside@example.test");
  const created = await h.request("/v1/org", owner, { name: "Team" }),
    org = BigInt(created.body.organizationId);
  await h.request("/v1/org/invitations", owner, {
    email: "member@example.test",
    assignSeat: false,
  });
  await h.request("/v1/org/invitations/accept", member, {
    token: new URL(h.links[0].link).hash.slice(1),
  });
  h.tx(() =>
    insertGrant(
      h.db,
      owner.id,
      "own-personal",
      "pack",
      100_000n,
      2n,
      h.clock(),
      null,
    ),
  );
  const noSeat = await h.request(
    "/v1/sessions",
    owner,
    {
      sessionId: randomUUID(),
      funding: { kind: "organization", organizationId: org.toString() },
    },
    { bearer: true },
  );
  assert.equal(noSeat.body.code, "no_seat");
  for (let id = 1; id <= 2; id++) {
    h.db
      .prepare(
        "INSERT INTO seats(id,organization_id,seat_number,status,created_at_ms) VALUES(?,?,?,'active',?)",
      )
      .run(id, org, id, h.clock());
    h.db
      .prepare(
        "INSERT INTO seat_periods(organization_id,seat_id,invoice_id,starts_ms,ends_ms,price_id,budget_ms,budget_briefs,financial_status) VALUES(?,?,'in_fixture',?,?,'price_monthly',36000000,20,'paid')",
      )
      .run(org, id, h.clock() - 1000n, h.clock() + 100_000n);
  }
  assert.equal(
    (
      await h.request("/v1/org/seats/1/assign", owner, {
        accountId: owner.id.toString(),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await h.request("/v1/org/seats/2/assign", owner, {
        accountId: outsider.id.toString(),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.request("/v1/org/seats/2/assign", owner, {
        accountId: member.id.toString(),
      })
    ).status,
    200,
  );
  const sessions = [randomUUID(), randomUUID()],
    funding = { kind: "organization", organizationId: org.toString() };
  const results = await Promise.all([
    h.request(
      "/v1/sessions",
      owner,
      { sessionId: sessions[0], funding },
      { bearer: true },
    ),
    h.request(
      "/v1/sessions",
      member,
      { sessionId: sessions[1], funding },
      { bearer: true },
    ),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  assert.equal(
    (
      await h.request(
        "/v1/sessions",
        owner,
        { sessionId: randomUUID(), funding },
        { bearer: true },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await h.request(
        "/v1/sessions",
        owner,
        { sessionId: sessions[0], funding: { kind: "personal" } },
        { bearer: true },
      )
    ).body.code,
    "funding_mismatch",
  );
  const summary = await h.request("/v1/account", owner, undefined, {
    bearer: true,
  });
  assert.equal(summary.body.allowances.pack.meetingMsAvailable, 100_000);
  assert.equal(summary.body.organization.id, org.toString());
  assert.equal(summary.body.organizationAllowance.totalBriefs, 20);
  assert.equal(
    (await h.request(`/v1/org/members/${owner.id}/remove`, member, {})).status,
    403,
  );
  assert.equal(
    (
      await h.request("/v1/org/transfer-owner", owner, {
        accountId: outsider.id.toString(),
      })
    ).status,
    403,
  );
});
