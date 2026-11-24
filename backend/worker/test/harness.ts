import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createAuth } from "../../src/auth.ts";
import { serviceAccount } from "../../src/authorize.ts";
import {
  insertGrant,
  MS_PER_HOUR,
  releaseBrief,
  reserveBrief,
  settleBriefSuccess,
} from "../../src/billing.ts";
import { migrateService } from "../../src/db.ts";
import { DoSqlite, type DoStorage } from "../../src/do-sqlite.ts";
import { migrate } from "../../src/migrate.ts";

const ISSUER = "http://127.0.0.1:8799";
const ROLLBACK = "forced rollback";

interface Stub {
  fetch(input: string): Promise<Response>;
}
interface Env {
  HARNESS: { idFromName(name: string): unknown; get(id: unknown): Stub };
}

function rows(db: DoSqlite, sql: string, ...params: unknown[]) {
  return db.prepare<unknown[], Record<string, unknown>>(sql).all(...params);
}

function count(db: DoSqlite, table: string): number {
  return Number(
    db
      .prepare<[], { n: number | bigint }>(`SELECT count(*) AS n FROM ${table}`)
      .get()!.n,
  );
}

function rejectsWith(fn: () => unknown, message: RegExp) {
  assert.throws(fn, (error: Error) => message.test(error.message));
}

export class Harness {
  readonly service: DoSqlite;
  readonly authDb: DoSqlite;
  readonly log: string[] = [];
  #auth?: Promise<ReturnType<typeof createAuth>>;

  constructor(readonly ctx: { storage: DoStorage }) {
    this.service = new DoSqlite(ctx.storage).defaultSafeIntegers(true);
    this.authDb = new DoSqlite(ctx.storage);
  }

  auth() {
    this.#auth ??= (async () => {
      const instance = createAuth(
        {
          BETTER_AUTH_URL: ISSUER,
          BETTER_AUTH_SECRET: "harness-secret-harness-secret-0123456789",
        },
        this.authDb,
      );
      await migrate(instance);
      return instance;
    })();
    return this.#auth;
  }

  async fetch(request: Request): Promise<Response> {
    const name = new URL(request.url).pathname.slice(1);
    const scenario = scenarios[name];
    if (!scenario)
      return new Response(`unknown scenario ${name}`, { status: 404 });
    try {
      return Response.json((await scenario(this, request)) ?? null);
    } catch (error) {
      return new Response(String((error as Error).stack ?? error), {
        status: 500,
      });
    }
  }
}

type Scenario = (harness: Harness, request: Request) => unknown;

const scenarios: Record<string, Scenario> = {
  integers({ service, authDb, ctx }) {
    service.exec("CREATE TABLE n(v INTEGER NOT NULL)");
    const max = 2n ** 53n - 1n;
    const insert = service.prepare("INSERT INTO n(v) VALUES(?)");
    assert.equal(insert.run(max).lastInsertRowid, 1n);
    insert.run(-max);
    assert.deepEqual(service.prepare("SELECT v FROM n ORDER BY rowid").all(), [
      { v: max },
      { v: -max },
    ]);
    assert.deepEqual(authDb.prepare("SELECT v FROM n ORDER BY rowid").all(), [
      { v: Number(max) },
      { v: -Number(max) },
    ]);
    assert.equal(
      authDb.prepare("INSERT INTO n(v) VALUES(1)").run().lastInsertRowid,
      3,
    );
    rejectsWith(() => insert.run(max + 1n), /beyond ±2\^53/);
    rejectsWith(() => insert.run(-max - 1n), /beyond ±2\^53/);
    rejectsWith(() => insert.run(true), /Cannot bind boolean/);
    rejectsWith(() => insert.run({ v: 1 }), /Cannot bind an object/);
    ctx.storage.sql.exec("INSERT INTO n(v) VALUES(9007199254740993)");
    rejectsWith(() => service.prepare("SELECT v FROM n").all(), /already lost/);
    rejectsWith(() => authDb.prepare("SELECT v FROM n").all(), /already lost/);
    assert.equal(count(service, "n"), 4);
  },

  "nested-inner-throw"({ service }) {
    service.exec("CREATE TABLE t(v TEXT)");
    const insert = service.prepare("INSERT INTO t(v) VALUES(?)");
    service
      .transaction(() => {
        insert.run("outer");
        assert.throws(() =>
          service.transaction(() => {
            insert.run("inner");
            assert.equal(service.inTransaction, true);
            throw new Error(ROLLBACK);
          })(),
        );
        insert.run("outer again");
      })
      .immediate();
    assert.equal(service.inTransaction, false);
    assert.deepEqual(rows(service, "SELECT v FROM t ORDER BY rowid"), [
      { v: "outer" },
      { v: "outer again" },
    ]);
  },

  "outer-throw"({ service }) {
    service.exec("CREATE TABLE t(v TEXT)");
    const insert = service.prepare("INSERT INTO t(v) VALUES(?)");
    assert.throws(
      () =>
        service
          .transaction(() => {
            service.transaction(() => insert.run("inner"))();
            insert.run("outer");
            throw new Error(ROLLBACK);
          })
          .immediate(),
      { message: ROLLBACK },
    );
    assert.equal(service.inTransaction, false);
    assert.equal(count(service, "t"), 0);
  },

  pragmas({ service }) {
    assert.equal(service.pragma("foreign_keys", { simple: true }), 1n);
    assert.deepEqual(service.pragma("journal_mode = WAL"), []);
    assert.equal(
      service.pragma("busy_timeout = 50", { simple: true }),
      undefined,
    );
    service.exec("CREATE TABLE p(id INTEGER PRIMARY KEY, v TEXT)");
    assert.deepEqual(
      (service.pragma("table_info('p')") as { name: string }[]).map(
        (c) => c.name,
      ),
      ["id", "v"],
    );
    rejectsWith(
      () => service.pragma("integrity_check"),
      /not supported on Durable Object SQL/,
    );
    rejectsWith(() => service.pragma("journal_mode"), /not supported/);
  },

  "migrate-twice"({ service }) {
    const schema = () =>
      rows(
        service,
        "SELECT type, name, sql FROM sqlite_master ORDER BY type, name",
      );
    migrateService(service);
    const first = schema();
    assert.ok(first.some((row) => row.name === "usage_events"));
    migrateService(service);
    assert.deepEqual(schema(), first);
    assert.equal(service.inTransaction, false);
  },

  ledger({ service }) {
    migrateService(service);
    const db = service;
    const now = 1_800_000_000_000n;
    const account = serviceAccount(db, ISSUER, "ledger-user", false, now);
    assert.equal(typeof account.id, "bigint");
    db.transaction(() =>
      insertGrant(
        db,
        account.id,
        "pack:ledger",
        "pack",
        10n * MS_PER_HOUR,
        2n,
        now,
        null,
      ),
    ).immediate();
    const grant = () =>
      db
        .prepare<[bigint], { briefs_reserved: bigint; briefs_used: bigint }>(
          "SELECT briefs_reserved, briefs_used FROM allowance_grants WHERE account_id=? AND origin='pack:ledger'",
        )
        .get(account.id);
    db.transaction(() => reserveBrief(db, account.id, "k1", now)).immediate();
    assert.deepEqual(grant(), { briefs_reserved: 1n, briefs_used: 0n });
    db.transaction(() =>
      releaseBrief(db, account.id, "k1", now + 1n),
    ).immediate();
    assert.deepEqual(grant(), { briefs_reserved: 0n, briefs_used: 0n });
    db.transaction(() => reserveBrief(db, account.id, "k2", now)).immediate();
    db.transaction(() =>
      settleBriefSuccess(db, account.id, "k2", now + 2n),
    ).immediate();
    assert.deepEqual(grant(), { briefs_reserved: 0n, briefs_used: 1n });
    db.transaction(() => reserveBrief(db, account.id, "k3", now)).immediate();
    assert.throws(
      () =>
        db
          .transaction(() => reserveBrief(db, account.id, "k4", now))
          .immediate(),
      { code: "quota_exhausted" },
    );
    assert.equal(
      db
        .prepare("SELECT 1 FROM provider_requests WHERE request_key='k4'")
        .get(),
      undefined,
    );
    assert.throws(() => releaseBrief(db, account.id, "k3", now), {
      message: "Ledger changes require a transaction",
    });
    assert.deepEqual(
      rows(
        db,
        "SELECT kind, amount_briefs, operation_key FROM usage_events WHERE account_id=? ORDER BY id",
        account.id,
      ),
      [
        {
          kind: "grant",
          amount_briefs: 2n,
          operation_key: "grant:pack:ledger",
        },
        {
          kind: "release",
          amount_briefs: 1n,
          operation_key: `brief-release:${account.id}:k1`,
        },
        {
          kind: "debit_brief",
          amount_briefs: 1n,
          operation_key: `brief:${account.id}:k2`,
        },
      ],
    );
  },

  async "auth-rollback"(harness) {
    const { authDb } = harness;
    const context = await (await harness.auth()).auth.$context;
    const users = (email: string) =>
      rows(authDb, 'SELECT id FROM "user" WHERE email=?', email).length;

    authDb.exec(
      "CREATE TRIGGER fail_account BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'forced account failure'); END",
    );
    await assert.rejects(
      context.internalAdapter.createOAuthUser(
        { email: "partial@example.com", name: "Partial", emailVerified: true },
        { providerId: "google", accountId: "google-partial" },
      ),
      /forced account failure/,
    );
    assert.equal(users("partial@example.com"), 0);
    authDb.exec("DROP TRIGGER fail_account");

    const created = await context.internalAdapter.createOAuthUser(
      { email: "whole@example.com", name: "Whole", emailVerified: true },
      { providerId: "google", accountId: "google-whole" },
    );
    assert.equal(users("whole@example.com"), 1);
    assert.equal(
      rows(authDb, "SELECT id FROM account WHERE userId=?", created.user.id)
        .length,
      1,
    );

    await assert.rejects(
      context.adapter.transaction(async (trx) => {
        await trx.create({
          model: "verification",
          data: {
            identifier: "mid-flow",
            value: "v",
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        assert.equal(
          rows(authDb, "SELECT 1 FROM verification WHERE identifier='mid-flow'")
            .length,
          1,
        );
        await sleep(5);
        throw new Error(ROLLBACK);
      }),
      { message: ROLLBACK },
    );
    assert.equal(
      rows(authDb, "SELECT 1 FROM verification WHERE identifier='mid-flow'")
        .length,
      0,
    );
    const limit = rows(authDb, "SELECT count FROM rateLimit LIMIT 1");
    assert.ok(limit.every((row) => typeof row.count === "number"));
  },

  async "auth-setup"(harness) {
    await harness.auth();
    migrateService(harness.service);
  },

  async "hold-auth"(harness, request) {
    const ms = Number(new URL(request.url).searchParams.get("ms"));
    const context = await (await harness.auth()).auth.$context;
    await assert.rejects(
      context.adapter.transaction(async (trx) => {
        await trx.create({
          model: "verification",
          data: {
            identifier: "held",
            value: "v",
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        harness.log.push("hold:begin");
        await sleep(ms);
        harness.log.push("hold:end");
        throw new Error(ROLLBACK);
      }),
      { message: ROLLBACK },
    );
  },

  "ledger-write"({ service, log }) {
    const now = 1_800_000_000_000n;
    const account = serviceAccount(
      service,
      ISSUER,
      "concurrent-user",
      false,
      now,
    );
    service
      .transaction(() =>
        insertGrant(
          service,
          account.id,
          `pack:${log.length}`,
          "pack",
          MS_PER_HOUR,
          1n,
          now,
          null,
        ),
      )
      .immediate();
    log.push("write");
  },

  observe({ service, authDb, log }) {
    return {
      log,
      grants: count(service, "usage_events"),
      held: rows(authDb, "SELECT 1 FROM verification WHERE identifier='held'")
        .length,
    };
  },
};

async function call(stub: Stub, path: string) {
  const response = await stub.fetch(`http://harness${path}`);
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body);
}

async function concurrency(env: Env) {
  const stub = env.HARNESS.get(env.HARNESS.idFromName(crypto.randomUUID()));
  await call(stub, "/auth-setup");
  const started = Date.now();
  const held = call(stub, "/hold-auth?ms=300");
  await sleep(50);
  await Promise.all([held, call(stub, "/ledger-write")]);
  const waited = Date.now() - started;
  await call(stub, "/ledger-write");
  const observed = await call(stub, "/observe");
  assert.deepEqual(observed.log, ["hold:begin", "hold:end", "write", "write"]);
  assert.equal(observed.grants, 2);
  assert.equal(observed.held, 0);
  assert.ok(waited >= 300, `the concurrent write finished after ${waited} ms`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/concurrency")
      return env.HARNESS.get(env.HARNESS.idFromName(crypto.randomUUID())).fetch(
        request.url,
      );
    try {
      await concurrency(env);
      return Response.json(null);
    } catch (error) {
      return new Response(String((error as Error).stack ?? error), {
        status: 500,
      });
    }
  },
};
