import { assertDistinctDatabases } from "./db.js";
import Database from "better-sqlite3";
import { createReadStream } from "node:fs";
import { mkdir, chmod, realpath, rm, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createConnection, isIP } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// Call only after draining the backend. These locks prevent either database from
// changing between snapshots; separate readers let SQLite's backup API run while
// the writer connections hold BEGIN IMMEDIATE on both WAL databases.
export async function backupDatabases(
  paths: { auth: string; service: string },
  destination: string,
) {
  assertDistinctDatabases(paths.auth, paths.service);
  const sources = await Promise.all([
    realpath(paths.auth),
    realpath(paths.service),
  ]);
  const locks: Database.Database[] = [];
  let created = false;
  try {
    for (const path of sources) {
      const db = new Database(path, { fileMustExist: true });
      locks.push(db);
      db.pragma("busy_timeout = 50");
      db.exec("BEGIN IMMEDIATE");
    }
    await mkdir(destination, { mode: 0o700 });
    created = true;
    const files: {
      role: string;
      file: string;
      bytes: number;
      sha256: string;
    }[] = [];
    let signingKeyIds: string[] = [];
    for (const [index, role] of ["auth", "service"].entries()) {
      const file = `${role}.sqlite`,
        target = join(destination, file);
      const source = new Database(sources[index], {
        readonly: true,
        fileMustExist: true,
      });
      try {
        await source.backup(target);
      } finally {
        source.close();
      }
      await chmod(target, 0o600);
      const copy = new Database(target, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        if (
          copy.pragma("integrity_check", { simple: true }) !== "ok" ||
          (copy.pragma("foreign_key_check") as unknown[]).length
        )
          throw new Error(`Invalid ${role} database backup`);
        if (role === "auth")
          signingKeyIds = copy
            .prepare<[], { id: string }>("SELECT id FROM jwks ORDER BY id")
            .all()
            .map((row) => row.id);
        else copy.prepare("SELECT id FROM accounts LIMIT 1").get();
      } finally {
        copy.close();
      }
      files.push({
        role,
        file,
        bytes: (await stat(target)).size,
        sha256: await digest(target),
      });
    }
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      files,
      signingKeyIds,
      requiredSecret:
        "BETTER_AUTH_SECRET must be restored separately from the secret store",
    };
    await writeFile(
      join(destination, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return manifest;
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    for (const db of locks.reverse()) {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
  }
}

export async function requireStopped(env: NodeJS.ProcessEnv) {
  const host = env.SAVVY_HOST ?? "127.0.0.1",
    port = Number(env.PORT ?? 8788);
  if (!isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Backup requires the backend's configured listen address");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1000, () =>
      socket.destroy(new Error("Cannot verify backend is stopped")),
    );
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Stop and drain the backend before backup"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(await realpath(process.argv[1])).href
) {
  const destination = process.argv[2];
  if (!destination || process.argv.length !== 3)
    throw new Error("Usage: node build/backup.js NEW_BACKUP_DIRECTORY");
  await requireStopped(process.env);
  await backupDatabases(
    {
      auth: process.env.SAVVY_AUTH_DATABASE ?? "savvy-auth.sqlite",
      service: process.env.SAVVY_DB_PATH ?? "savvy-service.sqlite",
    },
    resolve(destination),
  );
  console.log(
    "Both database snapshots and integrity manifest saved. Keep the auth secret in its separate secret store.",
  );
}
