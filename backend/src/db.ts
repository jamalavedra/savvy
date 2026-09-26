import Database from "better-sqlite3";
import {
  readFileSync,
  openSync,
  closeSync,
  fchmodSync,
  fstatSync,
  constants,
  realpathSync,
  statSync,
  lstatSync,
  readlinkSync,
} from "node:fs";

import { resolve, dirname, basename, join } from "node:path";

export function assertDistinctDatabases(auth: string, service: string) {
  function canonical(path: string): string {
    try {
      return realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
        return canonical(resolve(dirname(path), readlinkSync(path)));
      return join(canonical(dirname(path)), basename(path));
    }
  }
  const paths = [auth, service].map((path) => canonical(resolve(path)));
  const files = paths.map((path) => statSync(path, { throwIfNoEntry: false }));
  if (
    paths[0] === paths[1] ||
    (files[0] &&
      files[1] &&
      files[0].dev === files[1].dev &&
      files[0].ino === files[1].ino)
  )
    throw new Error("Auth and service databases must be distinct");
}

export type Db = Database.Database;

// SQLite otherwise creates the main file as 0644 before a later chmod can run.
export function openPrivateDatabase(path: string): Db {
  if (path === ":memory:") return new Database(path);
  const directory = statSync(dirname(resolve(path)));
  if (directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0)
    throw new Error(
      "Database directory must be owned by this user and not writable by others",
    );
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    let fd: number;
    try {
      fd = openSync(
        file,
        constants.O_RDWR |
          constants.O_NOFOLLOW |
          (file === path ? constants.O_CREAT | constants.O_EXCL : 0),
        0o600,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (file !== path && code === "ENOENT") continue;
      if (file !== path || code !== "EEXIST") throw error;
      fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1)
        throw new Error(
          "Database files must be regular, owned files without hardlinks",
        );
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  }
  return new Database(path, { fileMustExist: true });
}

export function migrateService(db: Db) {
  db.transaction(() => {
    db.exec(
      readFileSync(new URL("./service-schema.sql", import.meta.url), "utf8"),
    );
    const columns = [
      ["managed_sessions", "lifecycle_command", "INTEGER NOT NULL DEFAULT 0"],
      ["checkouts", "created_at_ms", "INTEGER NOT NULL DEFAULT 0"],
      ["checkouts", "price_id", "TEXT"],
      ["checkouts", "return_url", "TEXT"],
      ["checkouts", "subscription_id", "TEXT"],
      ["checkouts", "search_cursor", "TEXT"],
      ["checkouts", "checked_at_ms", "INTEGER NOT NULL DEFAULT 0"],
      ["billing_events", "checked_at_ms", "INTEGER NOT NULL DEFAULT 0"],
      ["subscriptions", "checked_at_ms", "INTEGER NOT NULL DEFAULT 0"],
      ["reversals", "refunded", "INTEGER NOT NULL DEFAULT 0"],
      ["reversals", "disputed", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [table, field, definition] of columns) {
      const exists = db
        .prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`)
        .get(field);
      if (!exists)
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${field} ${definition}`);
    }
    db.exec(
      "UPDATE checkouts SET search_cursor=NULL WHERE stripe_id IS NULL AND state IN ('pending','payment_pending')",
    );
  }).immediate();
}

export function openServiceDatabase(path: string): Db {
  const db = openPrivateDatabase(path);
  try {
    db.defaultSafeIntegers(true);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // Avoid blocking authentication on the shared event loop for seconds.
    // The single writer owns its database; contention is an operational fault.
    db.pragma("busy_timeout = 50");
    migrateService(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
