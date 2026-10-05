import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { mkdtemp, rm, access, link, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { backupDatabases, requireStopped } from "./backup.js";

test("backup refuses a listening backend and releases both locks after contention or invalid schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "savvy-backup-guards-"));
  const paths = {
    auth: join(directory, "auth.sqlite"),
    service: join(directory, "service.sqlite"),
  };
  const auth = new Database(paths.auth),
    service = new Database(paths.service);
  const listener = createServer((socket) => socket.end());
  try {
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const env = { PORT: String(address.port), SAVVY_HOST: "127.0.0.1" };
    await assert.rejects(requireStopped(env), /Stop and drain/);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await requireStopped(env);
    for (const db of [auth, service]) db.pragma("journal_mode = WAL");
    service.exec("BEGIN IMMEDIATE");
    const destination = join(directory, "snapshot");
    await assert.rejects(backupDatabases(paths, destination), {
      code: "SQLITE_BUSY",
    });
    auth.exec("BEGIN IMMEDIATE; ROLLBACK");
    service.exec("ROLLBACK");
    await assert.rejects(access(destination));
    await assert.rejects(backupDatabases(paths, destination), /jwks/);
    await assert.rejects(access(destination));
    for (const db of [auth, service]) db.exec("BEGIN IMMEDIATE; ROLLBACK");
    await assert.rejects(
      backupDatabases({ auth: paths.auth, service: paths.auth }, destination),
      /distinct/,
    );
    const alias = join(directory, "alias.sqlite");
    await link(paths.auth, alias);
    await assert.rejects(
      backupDatabases({ auth: paths.auth, service: alias }, destination),
      /distinct/,
    );
    await rm(alias);
    const missing = join(directory, "not-created.sqlite");
    const dangling = join(directory, "dangling.sqlite");
    await symlink(missing, dangling);
    await assert.rejects(
      backupDatabases({ auth: missing, service: dangling }, destination),
      /distinct/,
    );
    await symlink(directory, join(directory, "alias"));
    await assert.rejects(
      backupDatabases(
        {
          auth: join(directory, "new.sqlite"),
          service: join(directory, "alias/new.sqlite"),
        },
        destination,
      ),
      /distinct/,
    );
  } finally {
    if (listener.listening)
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    auth.close();
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
