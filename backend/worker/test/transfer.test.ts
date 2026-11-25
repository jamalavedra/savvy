import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { createTestHarness } from "wrangler";
import { requiredCapability } from "../../src/rollback-preflight.ts";
import {
  differences,
  scan,
  type Manifest,
  type Query,
} from "../../src/snapshot.ts";
import {
  adminSender,
  importFiles,
  restoreExport,
  sourceManifest,
  type Paths,
  type Send,
} from "../../src/transfer.ts";
import { admin as adminRoute, type AdminContext } from "../admin.ts";
import { addBulk, buildFixture, FIXTURE_SECRET } from "./fixture.ts";
import { ADMIN_TOKEN } from "./seal.ts";

const backend = new URL("../../", import.meta.url).pathname;
const server = createTestHarness({
  workers: [
    {
      configPath: new URL("./entry.wrangler.jsonc", import.meta.url),
      secrets: {
        BETTER_AUTH_SECRET: FIXTURE_SECRET,
        SAVVY_ANTHROPIC_API_KEY: "synthetic",
        SAVVY_DEEPGRAM_API_KEY: "synthetic",
        ADMIN_TOKEN,
      },
    },
  ],
});
const directory = mkdtempSync(join(tmpdir(), "savvy-transfer-"));
const source: Paths = {
  auth: join(directory, "auth.sqlite"),
  service: join(directory, "service.sqlite"),
};
let send: Send;

before(async () => {
  await buildFixture(source);
  send = adminSender((await server.listen()).url.href, ADMIN_TOKEN);
});
after(async () => {
  await server.close();
  rmSync(directory, { recursive: true, force: true });
});

const fileQuery =
  (db: Database.Database): Query =>
  (sql) =>
    db.prepare(sql).all() as Record<string, string | number | null>[];

function fileManifest(path: string): Manifest {
  const db = new Database(path, { readonly: true });
  try {
    return scan(fileQuery(db));
  } finally {
    db.close();
  }
}

async function admin(path: string, body: unknown, token = ADMIN_TOKEN) {
  const response = await server.fetch(`/__admin/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as never };
}

async function freePort() {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as { port: number };
  probe.close();
  return port;
}

async function nodeReady(paths: Paths) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: backend,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: FIXTURE_SECRET,
      SAVVY_AUTH_DATABASE: paths.auth,
      SAVVY_DB_PATH: paths.service,
      SAVVY_ANTHROPIC_API_KEY: "synthetic",
      SAVVY_DEEPGRAM_API_KEY: "synthetic",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      assert.equal(child.exitCode, null, stderr);
      const ready = await fetch(`${origin}/ready`).catch(() => null);
      if (ready) return ready.status;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Node backend never answered: ${stderr}`);
  } finally {
    child.kill("SIGINT");
    await once(child, "exit");
  }
}

test("an unsealed object answers 503 and admin routes demand the token", async () => {
  const ready = await server.fetch("/ready");
  assert.equal(ready.status, 503);
  assert.equal(
    ((await ready.json()) as { error: string }).error,
    "import_pending",
  );
  const wrong = await admin("seal", {}, "not-the-token");
  assert.equal(wrong.status, 401);
  const missing = await server.fetch("/__admin/manifest");
  assert.equal(missing.status, 401);
});

test("integers at or beyond 2^53 are refused before anything is sent", async () => {
  const copy = {
    auth: join(directory, "big-auth.sqlite"),
    service: join(directory, "big-service.sqlite"),
  };
  copyFileSync(source.auth, copy.auth);
  copyFileSync(source.service, copy.service);
  const db = new Database(copy.service);
  db.prepare("UPDATE usage_events SET amount_ms=? WHERE rowid=1").run(
    2n ** 53n,
  );
  db.close();
  const sent: string[] = [];
  await assert.rejects(
    importFiles(copy, async (path) => sent.push(path)),
    /usage_events\.amount_ms holds an integer at or beyond ±2\^53/,
  );
  assert.deepEqual(sent, []);
});

async function sql(text: string) {
  const response = await server.fetch("/__probe/sql", {
    method: "POST",
    body: text,
  });
  return { status: response.status, body: (await response.json()) as never };
}

function copySource(tag: string): Paths {
  const copy = {
    auth: join(directory, `${tag}-auth.sqlite`),
    service: join(directory, `${tag}-service.sqlite`),
  };
  copyFileSync(source.auth, copy.auth);
  copyFileSync(source.service, copy.service);
  return copy;
}

async function exportAndRestore(tag: string) {
  const exported = (await send("export", {})) as { key: string };
  const env = await server.getWorker<{ BACKUPS: R2Bucket }>().getEnv();
  const object = await env.BACKUPS.get(exported.key);
  const file = join(directory, `${tag}.ndjson`);
  writeFileSync(file, await object!.text());
  const restored = {
    auth: join(directory, `${tag}-restored-auth.sqlite`),
    service: join(directory, `${tag}-restored-service.sqlite`),
  };
  await restoreExport(file, restored);
  return { size: object!.size, restored };
}

function assertSameFiles(actual: Paths, expected: Paths) {
  for (const role of ["auth", "service"] as const)
    assert.deepEqual(
      fileManifest(actual[role]),
      fileManifest(expected[role]),
      role,
    );
}

test("admin routes answer 403 while ADMIN_TOKEN is unset", async () => {
  const response = await adminRoute(
    { token: undefined } as AdminContext,
    new Request("https://backend/__admin/manifest", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }),
  );
  assert.equal(response.status, 403);
});

test("text that is not valid UTF-8 is refused before anything is sent", async () => {
  const copy = copySource("utf8");
  const db = new Database(copy.service);
  db.exec(
    "UPDATE billing_events SET event_type=CAST(x'41ff42' AS TEXT) WHERE rowid=1",
  );
  db.close();
  const sent: string[] = [];
  await assert.rejects(
    importFiles(copy, async (path) => sent.push(path)),
    /billing_events\.event_type holds text that is not valid UTF-8/,
  );
  assert.deepEqual(sent, []);
});

test("a failed restore leaves no file behind", async () => {
  const file = join(directory, "truncated.ndjson");
  const schema = [
    { type: "table", name: "t", tbl_name: "t", sql: "CREATE TABLE t(a)" },
  ];
  writeFileSync(
    file,
    [{ schema }, { table: "t", columns: ["a"] }, ["i1"]]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  const target = {
    auth: join(directory, "truncated-auth.sqlite"),
    service: join(directory, "truncated-service.sqlite"),
  };
  await assert.rejects(restoreExport(file, target), /truncated/);
  for (const path of Object.values(target))
    for (const suffix of ["", "-wal", "-shm"])
      assert.equal(existsSync(path + suffix), false, path + suffix);
});

test("the rollback preflight reports a non-JSON error answer", async () => {
  const proxy = createHttpServer((_, res) =>
    res.writeHead(502).end("<html>bad gateway</html>"),
  ).listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const { port } = proxy.address() as { port: number };
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/rollback-preflight.ts",
          "--url",
          `http://127.0.0.1:${port}`,
          "--candidate",
          join(directory, "none.json"),
        ],
        { cwd: backend, env: { ...process.env, SAVVY_ADMIN_TOKEN: "t" } },
      ),
      /manifest answered 502: <html>bad gateway/,
    );
  } finally {
    proxy.close();
  }
});

test("a refused seal is aborted, and a fresh import seals with foreign keys on", async () => {
  const tampering: Send = (path, body) => {
    const chunk = body as { table?: string; rows?: (string | null)[][] };
    if (chunk.table === "usage_events") chunk.rows![0]![6] = "i6";
    return send(path, body);
  };
  await assert.rejects(
    importFiles(source, tampering),
    /seal answered 409: .*content of table usage_events/,
  );
  assert.equal((await server.fetch("/ready")).status, 503);
  const expected = sourceManifest(source);
  const own = await send("manifest");
  await assert.rejects(send("seal", own), /seal answered 409: .*mismatch/);
  const again = await admin("import/begin", expected);
  assert.equal(again.status, 409);
  assert.equal((again.body as { error: string }).error, "not_empty");

  assert.equal((await admin("import/abort", {})).status, 200);
  await importFiles(source, send);
  assert.equal((await server.fetch("/ready")).status, 200);
  assert.deepEqual((await sql("PRAGMA foreign_keys")).body, [
    { foreign_keys: 1 },
  ]);
  const orphan = await sql(
    "INSERT INTO stripe_payments(payment_id,invoice_id,account_id) VALUES('orphan','i',987654321)",
  );
  assert.equal(orphan.status, 400);
  assert.match(JSON.stringify(orphan.body), /FOREIGN KEY constraint failed/);
  const sealed = await admin("import/abort", {});
  assert.equal(sealed.status, 409);
  assert.equal((sealed.body as { error: string }).error, "sealed");
});

test("a backend that fails to boot stays unsealed and its import can be aborted", async () => {
  await server.reset();
  send = adminSender((await server.listen()).url.href, ADMIN_TOKEN);
  const broken = copySource("boot");
  const db = new Database(broken.service);
  db.exec(
    "CREATE TRIGGER refuse_boot BEFORE INSERT ON service_capabilities BEGIN SELECT RAISE(ABORT, 'boot refused'); END",
  );
  db.close();
  await assert.rejects(importFiles(broken, send), /seal answered 5\d\d/);
  assert.equal((await server.fetch("/ready")).status, 503);
  assert.equal((await admin("import/abort", {})).status, 200);
  await importFiles(source, send);
  assert.equal((await server.fetch("/ready")).status, 200);
});

test("the staging Worker serves funded team data and production refuses it at capability 1", async () => {
  const funded = copySource("funded");
  const db = new Database(funded.service);
  db.exec(
    "INSERT OR REPLACE INTO service_capabilities (key, value, set_at_ms) VALUES ('required_funding_schema', '2', 0)",
  );
  db.close();

  for (const env of ["staging", "production"]) {
    const candidate = createTestHarness({
      workers: [
        {
          configPath: new URL("../../wrangler.jsonc", import.meta.url),
          env,
          secrets: {
            BETTER_AUTH_SECRET: FIXTURE_SECRET,
            SAVVY_ANTHROPIC_API_KEY: "synthetic",
            SAVVY_DEEPGRAM_API_KEY: "synthetic",
            ADMIN_TOKEN,
          },
        },
      ],
    });
    try {
      await candidate.listen();
      const { BACKEND } = await candidate
        .getWorker<{ BACKEND: DurableObjectNamespace }>()
        .getEnv();
      // Local workerd cannot apply the EU jurisdiction in the public entrypoint.
      const object = () => BACKEND.getByName("primary");
      const origin = "http://127.0.0.1:8788";
      const send: Send = async (path, body) => {
        const response = await object().fetch(`${origin}/__admin/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        assert.equal(response.status, 200, path);
        return response.json();
      };
      const ready = () =>
        object().fetch(`${origin}/ready`, {
          headers: { "x-savvy-proxy-ip": "127.0.0.1" },
        });
      if (env === "staging") {
        await importFiles(funded, send);
        assert.equal((await ready()).status, 200);
      } else {
        await assert.rejects(
          importFiles(funded, send),
          /Backend cannot enforce this database's funding requirements/,
        );
        assert.equal((await ready()).status, 503);
      }
    } finally {
      await candidate.close();
    }
  }
});

test("freeze stops traffic, exports what was sealed and resumes on re-seal", async () => {
  await server.reset();
  send = adminSender((await server.listen()).url.href, ADMIN_TOKEN);
  const unsealed = await admin("freeze", {});
  assert.equal((unsealed.body as { error: string }).error, "not_sealed");
  await importFiles(source, send);
  assert.deepEqual(await send("freeze", {}), { frozen: true });
  assert.equal((await server.fetch("/ready")).status, 503);
  const pending = await admin("import/abort", {});
  assert.equal((pending.body as { error: string }).error, "no_import");

  const { restored } = await exportAndRestore("frozen");
  assertSameFiles(restored, source);
  await send("seal", await send("manifest"));
  assert.equal((await server.fetch("/ready")).status, 200);
});

test("an export over 16 MiB uploads equal parts and restores to the source", async () => {
  await server.reset();
  send = adminSender((await server.listen()).url.href, ADMIN_TOKEN);
  const large = copySource("large");
  addBulk(large.service, 7000, 5000);
  await importFiles(large, send);
  const { size, restored } = await exportAndRestore("large");
  assert.ok(size > 16 * 1024 * 1024, String(size));
  assertSameFiles(restored, large);
});

test("VPS files import into the object, export to R2 and restore to files the Node backend serves", async () => {
  await server.reset();
  send = adminSender((await server.listen()).url.href, ADMIN_TOKEN);
  const { manifest } = await importFiles(source, send);
  assert.ok(manifest.tables.every((table) => table.rows > 0));
  assert.equal((await server.fetch("/ready")).status, 200);
  const sealedAgain = await admin("import/begin", manifest);
  assert.equal((sealedAgain.body as { error: string }).error, "sealed");

  const exported = (await send("export", {})) as {
    key: string;
    manifest: Manifest;
  };
  assert.match(exported.manifest.bookmark ?? "", /\w/);
  assert.deepEqual(differences(manifest, exported.manifest), []);
  const env = await server.getWorker<{ BACKUPS: R2Bucket }>().getEnv();
  const object = await env.BACKUPS.get(exported.key);
  const file = join(directory, "export.ndjson");
  writeFileSync(file, await object!.text());

  const restored = {
    auth: join(directory, "restored-auth.sqlite"),
    service: join(directory, "restored-service.sqlite"),
  };
  await restoreExport(file, restored);
  for (const role of ["auth", "service"] as const)
    assert.deepEqual(
      fileManifest(restored[role]),
      fileManifest(source[role]),
      role,
    );
  await assert.rejects(restoreExport(file, restored), /exists/);
  assert.equal(await nodeReady(restored), 200);

  const db = new Database(source.service, { readonly: true });
  db.defaultSafeIntegers(true);
  const required = requiredCapability(db);
  db.close();
  assert.equal(required, 2);
  assert.equal(exported.manifest.requiredFundingSchema, required);
  const preflight = (funding: number) => {
    const candidate = join(directory, `capabilities-${funding}.json`);
    writeFileSync(candidate, JSON.stringify({ funding_schema: funding }));
    return promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/rollback-preflight.ts",
        "--url",
        origin,
        "--candidate",
        candidate,
      ],
      { cwd: backend, env: { ...process.env, SAVVY_ADMIN_TOKEN: ADMIN_TOKEN } },
    );
  };
  const origin = (await server.listen()).url.href;
  await assert.rejects(
    preflight(1),
    /below database requirement 2; release switch refused/,
  );
  const { stdout } = await preflight(2);
  assert.deepEqual(JSON.parse(stdout), {
    requiredFundingSchema: 2,
    availableFundingSchema: 2,
  });
});

test("a multi-megabyte import keeps every statement under 100 KB and 100 parameters", async (t) => {
  await server.reset();
  send = adminSender((await server.listen()).url.href, ADMIN_TOKEN);
  const bulk = {
    auth: join(directory, "bulk-auth.sqlite"),
    service: join(directory, "bulk-service.sqlite"),
  };
  copyFileSync(source.auth, bulk.auth);
  copyFileSync(source.service, bulk.service);
  addBulk(bulk.service, 800, 5000);
  const { limits } = await importFiles(bulk, send);
  t.diagnostic(JSON.stringify(limits));
  assert.ok(limits.statements > 40, JSON.stringify(limits));
  assert.ok(limits.maxSqlBytes < 100_000, JSON.stringify(limits));
  assert.ok(limits.maxParameters <= 100, JSON.stringify(limits));
  assert.equal((await server.fetch("/ready")).status, 200);
});
