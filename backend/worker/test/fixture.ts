import Database from "better-sqlite3";
import { createAuth } from "../../src/auth.ts";
import { openServiceDatabase, type Db } from "../../src/db.ts";
import { migrate } from "../../src/migrate.ts";
import { quoteName } from "../../src/snapshot.ts";

export const FIXTURE_SECRET = "fixture-secret-fixture-secret-0123456789";
const ROWS = 3;
const BASE_MS = 1_800_000_000_000n;
const LARGE = 2n ** 53n - 1n;

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}
interface ForeignKey {
  table: string;
  from: string;
  to: string | null;
}

const OVERRIDES: Record<string, (k: number) => unknown> = {
  "accounts.stripe_customer_id": () => null,
  '"user".image': (k) => (k === 3 ? Buffer.from([0, 1, 254, 255]) : null),
};

function allowed(sql: string, column: string): string[] | undefined {
  const match = new RegExp(
    `CHECK\\s*\\(\\s*"?${column}"?\\s+IN\\s*\\(([^)]*)\\)\\)`,
    "i",
  ).exec(sql);
  return match?.[1]!.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
}

function integer(name: string, k: number): bigint {
  if (/amount|total|used|reserved|debt|budget|tokens|cost/i.test(name))
    return LARGE - BigInt(k);
  if (name === "ends_ms") return BASE_MS + BigInt(k) * 1000n + 500n;
  if (/_ms$|lastRequest/.test(name)) return BASE_MS + BigInt(k) * 1000n;
  return BigInt(k);
}

function value(table: string, sql: string, column: Column, k: number) {
  const override =
    OVERRIDES[`${quoteName(table)}.${column.name}`] ??
    OVERRIDES[`${table}.${column.name}`];
  if (override) return override(k);
  const choices = allowed(sql, column.name);
  if (choices) {
    const last = choices.at(-1)!;
    return /^-?\d+$/.test(last) ? BigInt(last) : last;
  }
  if (!column.notnull && !column.pk && k === 2) return null;
  if (/int/i.test(column.type)) return integer(column.name, k);
  if (/date/i.test(column.type))
    return new Date(Number(BASE_MS) + k * 1000).toISOString();
  return `Zoë 🎙️ ${table}.${column.name} #${k} — 東京`;
}

function order(db: Db, tables: string[]) {
  const done: string[] = [];
  const visit = (table: string) => {
    if (done.includes(table)) return;
    for (const fk of db.pragma(
      `foreign_key_list(${quoteName(table)})`,
    ) as ForeignKey[])
      if (fk.table !== table) visit(fk.table);
    done.push(table);
  };
  tables.forEach(visit);
  return done;
}

/** Adds ROWS synthetic rows to every table, each satisfying its constraints and foreign keys. */
function fill(db: Db, skip: string[] = []) {
  db.defaultSafeIntegers(true);
  const tables = db
    .prepare<[], { name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all();
  const sqlOf = new Map(tables.map((t) => [t.name, t.sql]));
  for (const table of order(
    db,
    tables.map((t) => t.name),
  )) {
    if (skip.includes(table)) continue;
    const sql = sqlOf.get(table)!;
    const columns = db.pragma(`table_info(${quoteName(table)})`) as Column[];
    const fks = db.pragma(
      `foreign_key_list(${quoteName(table)})`,
    ) as ForeignKey[];
    const rowid =
      columns.filter((c) => c.pk).length === 1 &&
      columns.some((c) => c.pk && /^integer$/i.test(c.type));
    const used = columns.filter((c) => !(rowid && c.pk));
    const insert = db.prepare(
      `INSERT INTO ${quoteName(table)} (${used.map((c) => quoteName(c.name)).join(",")}) VALUES (${used.map(() => "?").join(",")})`,
    );
    for (let k = 1; k <= ROWS; k++) {
      if (/CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(sql)) break;
      insert.run(
        ...used.map((column) => {
          const fk = fks.find((f) => f.from === column.name);
          if (!fk) return value(table, sql, column, k);
          const parent = db
            .prepare(
              `SELECT ${quoteName(fk.to ?? "rowid")} AS v FROM ${quoteName(fk.table)} ORDER BY rowid DESC LIMIT 1 OFFSET ?`,
            )
            .get(BigInt(ROWS - k)) as { v: unknown };
          return parent.v;
        }),
      );
    }
  }
}

/** Both VPS databases, built by the real migrations, with rows in every table. */
export async function buildFixture(paths: { auth: string; service: string }) {
  const env = {
    BETTER_AUTH_URL: "http://127.0.0.1:8788",
    BETTER_AUTH_SECRET: FIXTURE_SECRET,
    SAVVY_AUTH_DATABASE: paths.auth,
    SAVVY_DB_PATH: paths.service,
  };
  const auth = createAuth(env);
  await migrate(auth);
  await auth.auth.api.signJWT({ body: { payload: { sub: "fixture" } } });
  fill(auth.db, ["jwks"]);
  auth.db.close();
  const service = openServiceDatabase(paths.service);
  fill(service);
  service.close();
}

/** Appends `rows` billing events of `bytes` each, plus one 150 KB event. */
export function addBulk(path: string, rows: number, bytes: number) {
  const db = new Database(path);
  const insert = db.prepare(
    "INSERT INTO billing_events(stripe_event_id,event_type,status,related_ids,created_at_ms) VALUES (?,?,'rejected',?,?)",
  );
  db.transaction(() => {
    for (let i = 0; i < rows; i++)
      insert.run(
        `evt_bulk_${i}`,
        "bulk",
        "é".repeat(bytes / 2),
        1_800_000_000_000 + i,
      );
    insert.run(
      "evt_bulk_large",
      "bulk",
      "x".repeat(150_000),
      1_800_000_000_000,
    );
  })();
  db.close();
}
