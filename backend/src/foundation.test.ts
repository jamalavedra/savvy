import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, chmod, stat, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from "jose";
import {
  openServiceDatabase,
  openPrivateDatabase,
  migrateService,
} from "./db.js";
import { createAuthorizer } from "./authorize.js";
import { ApiError, json } from "./errors.js";
import { configuration, systemClock } from "./config.js";

test("database opening restricts files and sidecars before use and rejects unsafe paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "savvy-private-db-"));
  const path = join(directory, "service.sqlite");
  const mask = process.umask(0);
  try {
    const db = openServiceDatabase(path);
    try {
      for (const file of [path, `${path}-wal`, `${path}-shm`])
        assert.equal((await stat(file)).mode & 0o777, 0o600);
    } finally {
      db.close();
    }
    await chmod(path, 0o644);
    const reopened = openPrivateDatabase(path);
    reopened.close();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const alias = join(directory, "alias.sqlite");
    await symlink(path, alias);
    assert.throws(() => openPrivateDatabase(alias));
    await rm(alias);
    await link(path, alias);
    assert.throws(() => openPrivateDatabase(alias), /without hardlinks/);
    await rm(alias);
    await symlink(path, `${path}-wal`);
    assert.throws(() => openPrivateDatabase(path));
    await rm(`${path}-wal`);
    assert.throws(() => openPrivateDatabase(directory));
    await chmod(directory, 0o777);
    assert.throws(() => openPrivateDatabase(path), /not writable by others/);
  } finally {
    process.umask(mask);
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified issuer/subject, current signing keys, and disabled accounts define ownership", async () => {
  const db = openServiceDatabase(":memory:");
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  let keys: JSONWebKeySet = {
    keys: [{ ...(await exportJWK(publicKey)), kid: "one", alg: "RS256" }],
  };
  const authorize = createAuthorizer(
    db,
    "https://auth.savvy.test",
    "savvy-tests",
    async () => keys,
    systemClock(),
  );
  const issue = (subject: string, overrides: Record<string, unknown> = {}) =>
    new SignJWT({
      sub: subject,
      email: "same@example.test",
      email_verified: true,
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: "one" })
      .setIssuer("https://auth.savvy.test")
      .setAudience("savvy-tests")
      .setExpirationTime("5m")
      .sign(privateKey);
  try {
    await assert.rejects(authorize({ cookie: "session=untrusted" }), {
      code: "sign_in_required",
    });
    const first = await issue("first"),
      second = await issue("second");
    const a = await authorize({ authorization: `Bearer ${first}` });
    const b = await authorize({ authorization: `Bearer ${second}` });
    assert.notEqual(
      a.accountId,
      b.accountId,
      "matching email never merges accounts",
    );
    assert.equal(
      (await authorize({ authorization: `Bearer ${first}` })).accountId,
      a.accountId,
    );
    const unverified = await issue("first", { email_verified: false });
    assert.equal(
      (await authorize({ authorization: `Bearer ${unverified}` }))
        .displayIdentity.email,
      null,
    );
    const nullable = await issue("first", {
      name: null,
      email: null,
      email_verified: null,
    });
    assert.equal(
      (await authorize({ authorization: `Bearer ${nullable}` })).displayIdentity
        .name,
      null,
    );
    const wrong = new SignJWT({ sub: "first" })
      .setProtectedHeader({ alg: "RS256", kid: "one" })
      .setIssuer("https://other.test")
      .setAudience("savvy-tests")
      .setExpirationTime("5m");
    await assert.rejects(
      authorize({ authorization: `Bearer ${await wrong.sign(privateKey)}` }),
      { code: "sign_in_required" },
    );
    const expired = new SignJWT({ sub: "first" })
      .setProtectedHeader({ alg: "RS256", kid: "one" })
      .setIssuer("https://auth.savvy.test")
      .setAudience("savvy-tests")
      .setExpirationTime(1);
    await assert.rejects(
      authorize({ authorization: `Bearer ${await expired.sign(privateKey)}` }),
      { code: "sign_in_required" },
    );
    const wrongAudience = new SignJWT({ sub: "first" })
      .setProtectedHeader({ alg: "RS256", kid: "one" })
      .setIssuer("https://auth.savvy.test")
      .setAudience("other")
      .setExpirationTime("5m");
    const forged = await generateKeyPair("RS256");
    for (const invalid of [
      await wrongAudience.sign(privateKey),
      await new SignJWT({ sub: "first" })
        .setProtectedHeader({ alg: "RS256", kid: "one" })
        .setIssuer("https://auth.savvy.test")
        .setAudience("savvy-tests")
        .setExpirationTime("5m")
        .sign(forged.privateKey),
      await new SignJWT({ sub: "first" })
        .setProtectedHeader({ alg: "HS256", kid: "one" })
        .sign(new Uint8Array(32)),
      "eyJhbGciOiJub25lIiwia2lkIjoib25lIn0.eyJzdWIiOiJmaXJzdCJ9.",
    ])
      await assert.rejects(authorize({ authorization: `Bearer ${invalid}` }), {
        code: "sign_in_required",
        status: 401,
      });
    keys = {
      keys: [
        { ...(await exportJWK(publicKey)), kid: "replacement", alg: "RS256" },
      ],
    };
    const replacement = await new SignJWT({ sub: "first" })
      .setProtectedHeader({ alg: "RS256", kid: "replacement" })
      .setIssuer("https://auth.savvy.test")
      .setAudience("savvy-tests")
      .setExpirationTime("5m")
      .sign(privateKey);
    const rotated = await Promise.all(
      Array.from({ length: 32 }, () =>
        authorize({ authorization: `Bearer ${replacement}` }),
      ),
    );
    assert.ok(rotated.every((result) => result.accountId === a.accountId));
    await Promise.all(
      Array.from({ length: 32 }, () =>
        assert.rejects(authorize({ authorization: `Bearer ${first}` }), {
          code: "sign_in_required",
        }),
      ),
    );
    keys = { keys: [] };
    await assert.rejects(authorize({ authorization: `Bearer ${first}` }), {
      code: "sign_in_required",
    });
    keys = {
      keys: [{ ...(await exportJWK(publicKey)), kid: "one", alg: "RS256" }],
    };
    db.prepare("UPDATE accounts SET disabled=1 WHERE id=?").run(a.accountId);
    await assert.rejects(authorize({ authorization: `Bearer ${first}` }), {
      status: 403,
    });
  } finally {
    db.close();
  }
});

test("service migrations preserve exact integers and roll back failed financial writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "savvy-db-parity-"));
  const path = join(directory, "service.sqlite");
  let db = openServiceDatabase(path);
  try {
    db.prepare(
      "INSERT INTO accounts(issuer,subject,created_at_ms) VALUES(?,?,?)",
    ).run("issuer", "subject", 1n);
    const huge = 9007199254740993n;
    db.prepare("INSERT INTO attempt_counters VALUES(1,'large',100,1,?)").run(
      huge,
    );
    migrateService(db);
    assert.equal(
      (
        db.prepare("SELECT count FROM attempt_counters").get() as {
          count: bigint;
        }
      ).count,
      huge,
    );
    assert.throws(() => json({ count: huge }), ApiError);
    assert.equal(
      json({ count: 9007199254740991n }),
      '{"count":9007199254740991}',
    );
    assert.throws(() =>
      db
        .transaction(() => {
          db.prepare("UPDATE attempt_counters SET count=0").run();
          throw new Error("abort");
        })
        .immediate(),
    );
    db.close();
    db = openServiceDatabase(path);
    assert.equal(
      (
        db.prepare("SELECT count FROM attempt_counters").get() as {
          count: bigint;
        }
      ).count,
      huge,
    );
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture configuration refuses public or deceptive endpoints and issuer changes", () => {
  const env = {
    BETTER_AUTH_URL: "http://127.0.0.1:8788",
    SAVVY_DEV_FIXTURES: "1",
    SAVVY_ANTHROPIC_BASE_URL: "http://127.0.0.1:9000",
    SAVVY_DEEPGRAM_URL: "ws://127.0.0.1:9000",
    SAVVY_STRIPE_BASE_URL: "http://127.0.0.1:9000",
    SAVVY_CHECKOUT_RETURN_URL: "http://127.0.0.1:9000",
    SAVVY_ANTHROPIC_API_KEY: "fixture",
    SAVVY_DEEPGRAM_API_KEY: "fixture",
    SAVVY_STRIPE_SECRET_KEY: "fixture",
    SAVVY_STRIPE_WEBHOOK_SECRET: "fixture",
    SAVVY_STRIPE_PRICE_MONTHLY: "price_monthly",
    SAVVY_STRIPE_PRICE_PACK: "price_pack",
  };
  assert.equal(configuration(env).port, 8788);
  for (const patch of [
    { SAVVY_HOST: "0.0.0.0" },
    { SAVVY_STRIPE_BASE_URL: "http://localhost.evil.test" },
    { SAVVY_STRIPE_BASE_URL: "http://127.0.0.1@evil.test" },
    { SAVVY_STRIPE_BASE_URL: "https://stripe.com" },
    { SAVVY_OIDC_ISSUER: "http://127.0.0.1:8787" },
  ])
    assert.throws(() => configuration({ ...env, ...patch }));
});
