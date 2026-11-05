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
import { LIFECYCLES, PAUSE_REASONS } from "./transition.js";

const SCHEMA = readFileSync(
  new URL("./service-schema.sql", import.meta.url),
  "utf8",
);
/** Columns whose values the schema restricts, as [table, column, values]. */
const CONSTRAINED_COLUMNS: [string, string, readonly string[]][] = [
  ...Object.entries(LIFECYCLES).map(
    ([table, { column, edges }]): [string, string, string[]] => [
      table,
      column,
      Object.keys(edges),
    ],
  ),
  ["managed_sessions", "pause_reason", PAUSE_REASONS],
];

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
  // Windows uses the containing profile's ACL; POSIX mode bits are not meaningful there.
  const posix = process.platform !== "win32";
  if (
    posix &&
    (directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0)
  )
    throw new Error(
      "Database directory must be owned by this user and not writable by others",
    );
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("Database files must not be symbolic links");
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
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (posix && info.uid !== process.getuid?.())
      )
        throw new Error(
          "Database files must be regular, owned files without hardlinks",
        );
      if (posix) fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  }
  return new Database(path, { fileMustExist: true });
}

/**
 * Rebuilds the lifecycle tables that predate their CHECK constraints, following
 * SQLite's documented ALTER TABLE procedure: create the new table, copy, drop
 * the old one, rename, recreate indexes, then check foreign keys. Refuses to
 * run while any row holds a value outside the allowed set. Foreign keys must be
 * off, so the caller disables them around the transaction.
 */
function addLifecycleConstraints(db: Db) {
  // Compare whole definitions, so a later change to an allowed set rebuilds the
  // table too. Rename quotes the table name and ADD COLUMN reformats, hence the
  // normalisation; a rebuilt table then matches and is left alone.
  const normalise = (sql: string) =>
    sql.replace(/["`]/g, "").replace(/\s+/g, " ").trim();
  const pending = Object.keys(LIFECYCLES).filter((table) => {
    const current = db
      .prepare<[string], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(table)!.sql;
    return normalise(current) !== normalise(canonicalDefinition(table));
  });
  if (pending.length === 0) return;
  const rebuilt = new Set(pending);
  for (const [table, column, values] of CONSTRAINED_COLUMNS) {
    if (!rebuilt.has(table)) continue;
    const stray = db
      .prepare<string[], { value: unknown }>(
        `SELECT ${column} AS value FROM ${table} WHERE ${column} NOT IN (${values.map(() => "?").join(",")}) LIMIT 1`,
      )
      .get(...values);
    if (stray)
      throw new Error(
        `${table}.${column} holds ${JSON.stringify(stray.value)}, outside the allowed set; the lifecycle constraint migration refuses to run`,
      );
  }
  for (const table of rebuilt) {
    // sqlite_master stores the statement without its IF NOT EXISTS clause.
    const prefix = `CREATE TABLE ${table} (`;
    const canonical = canonicalDefinition(table);
    if (!canonical.startsWith(prefix))
      throw new Error(`Unexpected schema definition for ${table}`);
    db.exec(`CREATE TABLE new_${table} (${canonical.slice(prefix.length)}`);
    const columns = (
      db.pragma(`table_info('new_${table}')`) as { name: string }[]
    )
      .map((c) => c.name)
      .join(",");
    db.exec(
      `INSERT INTO new_${table}(${columns}) SELECT ${columns} FROM ${table} ORDER BY rowid`,
    );
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE new_${table} RENAME TO ${table}`);
  }
  db.exec(SCHEMA);
  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'",
    )
    .all();
  for (const { name } of tables) {
    const parents = (
      db.pragma(`foreign_key_list('${name}')`) as { table: string }[]
    ).map((fk) => fk.table);
    if (!rebuilt.has(name) && !parents.some((p) => rebuilt.has(p))) continue;
    if ((db.pragma(`foreign_key_check('${name}')`) as unknown[]).length)
      throw new Error(
        `Foreign keys of ${name} are violated after rebuilding lifecycle tables`,
      );
  }
}
function canonicalDefinition(table: string): string {
  const scratch = new Database(":memory:");
  try {
    scratch.exec(SCHEMA);
    return scratch
      .prepare<[string], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(table)!.sql;
  } finally {
    scratch.close();
  }
}

export function migrateService(db: Db) {
  if (db.inTransaction)
    throw new Error("Service migration must start outside a transaction");
  const foreignKeys = db.pragma("foreign_keys", { simple: true }) as
    number | bigint;
  db.pragma("foreign_keys = OFF");
  try {
    migrateSchema(db);
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}
function migrateSchema(db: Db) {
  db.transaction(() => {
    db.exec(SCHEMA);
    const columns = [
      ["organization_checkouts", "stripe_item_id", "TEXT"],
      [
        "organization_quantity_changes",
        "stripe_subscription_id",
        "TEXT NOT NULL DEFAULT ''",
      ],
      [
        "organization_quantity_changes",
        "stripe_item_id",
        "TEXT NOT NULL DEFAULT ''",
      ],
      ["organization_quantity_changes", "price_id", "TEXT NOT NULL DEFAULT ''"],
      [
        "organization_quantity_changes",
        "previous_retire_seat_ids",
        "TEXT NOT NULL DEFAULT '[]'",
      ],
      ["organization_checkouts", "search_cursor", "TEXT"],
      ["managed_sessions", "funding_scope", "TEXT NOT NULL DEFAULT 'personal'"],
      [
        "managed_sessions",
        "funding_assignment_id",
        "INTEGER REFERENCES seat_assignments(id)",
      ],
      [
        "provider_requests",
        "funding_scope",
        "TEXT NOT NULL DEFAULT 'personal'",
      ],
      [
        "provider_requests",
        "funding_assignment_id",
        "INTEGER REFERENCES seat_assignments(id)",
      ],
      [
        "allowance_grants",
        "seat_period_id",
        "INTEGER REFERENCES seat_periods(id)",
      ],
      [
        "allowance_grants",
        "seat_assignment_id",
        "INTEGER REFERENCES seat_assignments(id)",
      ],
      ["allowance_grants", "revocation_reason", "TEXT"],
      ["composio_sessions", "user_id", "TEXT NOT NULL DEFAULT ''"],
      ["managed_sessions", "lifecycle_command", "INTEGER NOT NULL DEFAULT 0"],
      ["managed_sessions", "pause_reason", "TEXT"],
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
    addLifecycleConstraints(db);
    db.exec(`
      INSERT OR IGNORE INTO stripe_customers(stripe_customer_id,owner_kind,owner_id)
        SELECT stripe_customer_id,'account',id FROM accounts WHERE stripe_customer_id IS NOT NULL;
      INSERT OR IGNORE INTO service_capabilities(key,value,set_at_ms)
        VALUES('schema_funding_scope','1',0);
    `);
    if (
      db
        .prepare(
          `SELECT 1 FROM accounts a LEFT JOIN stripe_customers c ON c.stripe_customer_id=a.stripe_customer_id
      WHERE a.stripe_customer_id IS NOT NULL AND (c.stripe_customer_id IS NULL OR c.owner_kind<>'account' OR c.owner_id<>a.id) LIMIT 1`,
        )
        .get()
    )
      throw new Error(
        "Personal Stripe customer ownership conflicts with the customer registry",
      );
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
