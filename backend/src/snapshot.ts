import { createHash } from "node:crypto";
import { SCHEMA } from "./service-schema.js";

/**
 * One canonical value: `null`, or a string whose first letter names SQLite's
 * storage class and whose rest is the exact value: `i` integer in decimal, `r`
 * real as `%!.17g`, `t` text, `b` blob in uppercase hex. SQLite produces it on
 * both sides, so Node and Durable Object reads agree byte for byte.
 */
export type Value = string | null;
export type Database = "auth" | "service";
export interface SchemaEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
export interface TableManifest {
  name: string;
  database: Database;
  columns: string[];
  rows: number;
  /** SHA-256 over each row's JSON array of values plus "\n", in rowid order. */
  sha256: string;
}
export interface Manifest {
  schema: SchemaEntry[];
  tables: TableManifest[];
  createdAt?: string;
  bookmark?: string;
  requiredFundingSchema?: number;
}
export type Query = (
  sql: string,
) => Iterable<Record<string, string | number | null>>;

export const LIMITS = { statementBytes: 100_000, parameters: 100 };
const SAFE = 2n ** 53n;
const SERVICE_TABLES = new Set(
  [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!),
);

export function databaseOf(table: string): Database {
  return SERVICE_TABLES.has(table) ? "service" : "auth";
}

export const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The runtime's `_cf_` tables, and the table local workerd adds to name an object. */
const RUNTIME_TABLES =
  "tbl_name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND tbl_name <> '__miniflare_do_name'";

export function readSchema(query: Query): SchemaEntry[] {
  return [
    ...query(
      `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE ${RUNTIME_TABLES} ORDER BY type, name`,
    ),
  ] as unknown as SchemaEntry[];
}

function tables(schema: SchemaEntry[]) {
  const found = schema.filter((entry) => entry.type === "table");
  for (const { name, sql } of found)
    if (name.startsWith("sqlite_") || /WITHOUT\s+ROWID/i.test(sql ?? ""))
      throw new Error(
        `Table ${name} is an internal or WITHOUT ROWID table, which the transfer does not support`,
      );
  return found.map((entry) => entry.name);
}

function columnsOf(query: Query, table: string): string[] {
  return [
    ...query(`SELECT name FROM pragma_table_info(${quoteText(table)})`),
  ].map((row) => String(row.name));
}

const quoteText = (text: string) => `'${text.replaceAll("'", "''")}'`;

function canonicalSelect(table: string, columns: string[]) {
  const values = columns.map((column, index) => {
    const c = quoteName(column);
    return `CASE typeof(${c}) WHEN 'null' THEN NULL WHEN 'integer' THEN 'i'||${c} WHEN 'real' THEN 'r'||printf('%!.17g',${c}) WHEN 'text' THEN 't'||${c} ELSE 'b'||hex(${c}) END AS c${index}`;
  });
  return `SELECT ${values.join(", ")} FROM ${quoteName(table)} ORDER BY rowid`;
}

/** Refuses the first integer at or beyond ±2^53, which DO SQL reads inexactly. */
export function assertSafeIntegers(query: Query) {
  for (const table of tables(readSchema(query)))
    for (const column of columnsOf(query, table)) {
      const c = quoteName(column);
      const [hit] = query(
        `SELECT ${c} AS v FROM ${quoteName(table)} WHERE typeof(${c})='integer' AND (${c} >= ${SAFE} OR ${c} <= -${SAFE}) LIMIT 1`,
      );
      if (hit)
        throw new Error(
          `${table}.${column} holds an integer at or beyond ±2^53, which Durable Object SQL cannot store exactly; refusing the import`,
        );
    }
}

/**
 * Refuses the first text that is not valid UTF-8: reading it replaces the bad
 * bytes, so two different values would hash alike and import rewritten.
 */
export function assertValidText(query: Query) {
  for (const table of tables(readSchema(query)))
    for (const column of columnsOf(query, table)) {
      const c = quoteName(column);
      for (const { v, h } of query(
        `SELECT ${c} AS v, hex(CAST(${c} AS BLOB)) AS h FROM ${quoteName(table)} WHERE typeof(${c})='text'`,
      ))
        if (Buffer.from(String(v)).toString("hex").toUpperCase() !== h)
          throw new Error(
            `${table}.${column} holds text that is not valid UTF-8, which the transfer cannot copy exactly; refusing the import`,
          );
    }
}

/** The export file's lines in order: the schema, then each table header and its rows. */
export type ScanEvent =
  | { schema: SchemaEntry[] }
  | { table: string; columns: string[] }
  | { row: string };

/**
 * Reads every table except the runtime's `_cf_` tables, yielding each table
 * and its canonical row lines, and returns the manifest that hashes them.
 */
export function* scanEvents(query: Query): Generator<ScanEvent, Manifest> {
  const schema = readSchema(query);
  yield { schema };
  const manifests: TableManifest[] = [];
  for (const name of tables(schema)) {
    const columns = columnsOf(query, name);
    yield { table: name, columns };
    const hash = createHash("sha256");
    let rows = 0;
    for (const row of query(canonicalSelect(name, columns))) {
      const line = JSON.stringify(columns.map((_, i) => row[`c${i}`] ?? null));
      hash.update(line + "\n");
      rows++;
      yield { row: line };
    }
    manifests.push({
      name,
      database: databaseOf(name),
      columns,
      rows,
      sha256: hash.digest("hex"),
    });
  }
  return { schema, tables: manifests };
}

export const eventLine = (event: ScanEvent) =>
  "row" in event ? event.row : JSON.stringify(event);

export function scan(query: Query): Manifest {
  const events = scanEvents(query);
  for (;;) {
    const step = events.next();
    if (step.done) return step.value;
  }
}

/** Every way `actual` differs from `expected` in schema or table content. */
export function differences(expected: Manifest, actual: Manifest): string[] {
  const found: string[] = [];
  const key = (entry: SchemaEntry) => `${entry.type} ${entry.name}`;
  const schema = new Map(actual.schema.map((entry) => [key(entry), entry]));
  for (const entry of expected.schema)
    if (JSON.stringify(schema.get(key(entry))) !== JSON.stringify(entry))
      found.push(`schema of ${key(entry)}`);
  const known = new Set(expected.schema.map(key));
  for (const entry of actual.schema)
    if (!known.has(key(entry))) found.push(`unexpected ${key(entry)}`);
  const tables = new Map(actual.tables.map((table) => [table.name, table]));
  for (const table of expected.tables)
    if (JSON.stringify(tables.get(table.name)) !== JSON.stringify(table))
      found.push(`content of table ${table.name}`);
  return found;
}

/** Creation order: tables first, then the indexes, views and triggers over them. */
export function schemaStatements(
  schema: SchemaEntry[],
  phase: "tables" | "rest",
) {
  return schema.filter(
    (entry) =>
      entry.sql !== null && (entry.type === "table") === (phase === "tables"),
  );
}

export type Bound = string | number | ArrayBuffer;
interface Statement {
  sql: string;
  params: Bound[];
  bytes: number;
}

const encoder = new TextEncoder();
export const byteLength = (text: string) => encoder.encode(text).length;

export function decodeHex(hex: string): ArrayBuffer {
  if (!/^(?:[0-9A-F]{2})*$/.test(hex)) throw new Error("Invalid blob value");
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16)).buffer;
}

type Part = { literal: string } | { bound: Bound };

/** A literal for integers and NULL, which binding would turn into REAL. */
function part(value: Value): Part {
  if (value === null) return { literal: "NULL" };
  const payload = value.slice(1);
  switch (value[0]) {
    case "i": {
      if (!/^-?(0|[1-9][0-9]*)$/.test(payload))
        throw new Error("Invalid integer value");
      const n = BigInt(payload);
      if (n >= SAFE || n <= -SAFE)
        throw new Error("Integer at or beyond ±2^53 refused");
      return { literal: payload };
    }
    case "r":
      return { bound: Number(payload) };
    case "t":
      return { bound: payload };
    case "b":
      return { bound: decodeHex(payload) };
  }
  throw new Error(`Invalid value tag ${JSON.stringify(value[0])}`);
}

const boundBytes = (p: Bound) =>
  typeof p === "string"
    ? byteLength(p)
    : typeof p === "number"
      ? 8
      : p.byteLength;

/**
 * Packs rows into multi-row INSERT statements, each with at most 100 bound
 * parameters and under 100 KB of SQL plus bound bytes. Integers and NULLs are
 * SQL literals; text, reals and blobs are bound. A single row bigger than the
 * byte budget gets a statement of its own.
 */
export function* insertStatements(
  table: string,
  columns: string[],
  rows: Value[][],
): Generator<Statement> {
  const head = `INSERT INTO ${quoteName(table)} (${columns.map(quoteName).join(", ")}) VALUES `;
  let current: Statement | null = null;
  for (const row of rows) {
    if (row.length !== columns.length)
      throw new Error(`A row of ${table} has the wrong number of values`);
    const parts = row.map(part);
    const params = parts.flatMap((p) => ("bound" in p ? [p.bound] : []));
    if (params.length > LIMITS.parameters)
      throw new Error(`A row of ${table} needs more than 100 parameters`);
    const tuple = `(${parts.map((p) => ("bound" in p ? "?" : p.literal)).join(",")})`;
    const bytes =
      byteLength(tuple) +
      1 +
      params.reduce<number>((sum, p) => sum + boundBytes(p), 0);
    if (
      current &&
      (current.params.length + params.length > LIMITS.parameters ||
        current.bytes + bytes >= LIMITS.statementBytes)
    ) {
      yield current;
      current = null;
    }
    if (current) current.sql += ",";
    current ??= { sql: head, params: [], bytes: byteLength(head) };
    current.sql += tuple;
    current.params.push(...params);
    current.bytes += bytes;
  }
  if (current) yield current;
}
