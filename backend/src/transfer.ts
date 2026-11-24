import Database from "better-sqlite3";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { assertDistinctDatabases, openPrivateDatabase } from "./db.js";
import {
  assertSafeIntegers,
  databaseOf,
  decodeHex,
  differences,
  quoteName,
  scan,
  scanEvents,
  schemaStatements,
  type Database as Role,
  type Manifest,
  type Query,
  type SchemaEntry,
  type Value,
} from "./snapshot.js";

export interface Paths {
  auth: string;
  service: string;
}
export type Send = (path: string, body?: unknown) => Promise<unknown>;

const ROLES: Role[] = ["auth", "service"];
const BATCH_BYTES = 1_000_000;

const nodeQuery =
  (db: Database.Database): Query =>
  (sql) =>
    db.prepare(sql).iterate() as Iterable<
      Record<string, string | number | null>
    >;

function openSources(paths: Paths) {
  assertDistinctDatabases(paths.auth, paths.service);
  const opened = ROLES.map((role) => {
    const db = new Database(paths[role], {
      readonly: true,
      fileMustExist: true,
    });
    db.exec("BEGIN");
    return { role, db, query: nodeQuery(db) };
  });
  return {
    sources: opened,
    close: () => opened.forEach(({ db }) => db.close()),
  };
}

function merge(parts: { role: Role; manifest: Manifest }[]): Manifest {
  const names = new Set<string>();
  for (const { role, manifest } of parts) {
    for (const entry of manifest.schema) {
      if (names.has(entry.name))
        throw new Error(`${entry.name} exists in both databases`);
      names.add(entry.name);
      if (databaseOf(entry.tbl_name) !== role)
        throw new Error(
          `${entry.name} is in the ${role} database, but its table ${entry.tbl_name} belongs to ${databaseOf(entry.tbl_name)}`,
        );
    }
  }
  return {
    format: 1,
    schema: parts.flatMap((p) => p.manifest.schema),
    tables: parts.flatMap((p) => p.manifest.tables),
  };
}

/** The manifest of the two VPS files, after refusing integers beyond ±2^53. */
export function sourceManifest(paths: Paths): Manifest {
  const { sources, close } = openSources(paths);
  try {
    return merge(
      sources.map(({ role, query }) => {
        assertSafeIntegers(query);
        return { role, manifest: scan(query) };
      }),
    );
  } finally {
    close();
  }
}

/** Sends each table's rows in requests of about 1 MB, which the object splits into statements. */
async function pushRows(query: Query, send: Send) {
  const limits = { statements: 0, maxSqlBytes: 0, maxParameters: 0 };
  let batch: { table: string; rows: Value[][]; bytes: number } | null = null;
  const flush = async () => {
    if (!batch?.rows.length) return;
    const result = (await send("import/rows", batch)) as typeof limits;
    limits.statements += result.statements;
    limits.maxSqlBytes = Math.max(limits.maxSqlBytes, result.maxSqlBytes);
    limits.maxParameters = Math.max(limits.maxParameters, result.maxParameters);
    batch.rows = [];
    batch.bytes = 0;
  };
  for (const event of scanEvents(query)) {
    if ("table" in event) {
      await flush();
      batch = { table: event.table, rows: [], bytes: 0 };
    } else if ("row" in event && batch) {
      batch.rows.push(JSON.parse(event.row) as Value[]);
      batch.bytes += event.row.length;
      if (batch.bytes >= BATCH_BYTES) await flush();
    }
  }
  await flush();
  return limits;
}

/**
 * Copies both VPS files into an empty, unsealed object and seals it. The
 * object seals only when its own manifest matches this one, so success means
 * every table, row and schema statement arrived unchanged.
 */
export async function importFiles(paths: Paths, send: Send) {
  const expected = sourceManifest(paths);
  const { sources, close } = openSources(paths);
  const limits = { statements: 0, maxSqlBytes: 0, maxParameters: 0 };
  try {
    await send("import/begin", expected);
    for (const { query } of sources) {
      const pushed = await pushRows(query, send);
      limits.statements += pushed.statements;
      limits.maxSqlBytes = Math.max(limits.maxSqlBytes, pushed.maxSqlBytes);
      limits.maxParameters = Math.max(
        limits.maxParameters,
        pushed.maxParameters,
      );
    }
  } finally {
    close();
  }
  const sealed = (await send("seal", expected)) as Manifest;
  const found = differences(expected, sealed);
  if (found.length)
    throw new Error(`The sealed object differs in: ${found.join(", ")}`);
  return { manifest: expected, limits };
}

function nodeValue(value: Value) {
  if (value === null) return null;
  const payload = value.slice(1);
  if (value[0] === "i") return BigInt(payload);
  if (value[0] === "r") return Number(payload);
  if (value[0] === "t") return payload;
  if (value[0] === "b") return Buffer.from(decodeHex(payload));
  throw new Error(`Invalid value tag ${JSON.stringify(value[0])}`);
}

const roleOf = (entry: SchemaEntry) => databaseOf(entry.tbl_name);

function verifyRestored(db: Database.Database, role: Role, manifest: Manifest) {
  if (db.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error(`Restored ${role} database fails integrity_check`);
  if ((db.pragma("foreign_key_check") as unknown[]).length)
    throw new Error(`Restored ${role} database has foreign key violations`);
  const expected: Manifest = {
    format: 1,
    schema: manifest.schema.filter((entry) => roleOf(entry) === role),
    tables: manifest.tables.filter((table) => table.database === role),
  };
  const found = differences(expected, scan(nodeQuery(db)));
  if (found.length)
    throw new Error(
      `Restored ${role} database differs in: ${found.join(", ")}`,
    );
}

type Line =
  | { schema: SchemaEntry[] }
  | { table: string; columns: string[] }
  | { manifest: Manifest }
  | Value[];

/**
 * Writes an object export back into the two-file VPS layout: auth tables into
 * `paths.auth`, service tables into `paths.service`. Both files must not exist.
 * Each is checked against the export's manifest before this returns.
 */
export async function restoreExport(file: string, paths: Paths) {
  assertDistinctDatabases(paths.auth, paths.service);
  for (const role of ROLES)
    if (existsSync(paths[role]))
      throw new Error(`${paths[role]} exists; restore writes only new files`);
  const dbs = {
    auth: openPrivateDatabase(paths.auth),
    service: openPrivateDatabase(paths.service),
  };
  let insert: Database.Statement | undefined;
  let manifest: Manifest | undefined;
  try {
    for (const db of Object.values(dbs)) {
      db.pragma("foreign_keys = OFF");
      db.exec("BEGIN");
    }
    for await (const text of createInterface({
      input: createReadStream(file),
    })) {
      const line = JSON.parse(text) as Line;
      if (Array.isArray(line)) insert!.run(...line.map(nodeValue));
      else if ("schema" in line)
        for (const entry of schemaStatements(line.schema, "tables"))
          dbs[roleOf(entry)].exec(entry.sql!);
      else if ("table" in line)
        insert = dbs[databaseOf(line.table)].prepare(
          `INSERT INTO ${quoteName(line.table)} (${line.columns.map(quoteName).join(",")}) VALUES (${line.columns.map(() => "?").join(",")})`,
        );
      else manifest = line.manifest;
    }
    if (!manifest)
      throw new Error("The export has no manifest line; it is truncated");
    for (const entry of schemaStatements(manifest.schema, "rest"))
      dbs[roleOf(entry)].exec(entry.sql!);
    for (const role of ROLES) {
      dbs[role].exec("COMMIT");
      dbs[role].pragma("foreign_keys = ON");
      verifyRestored(dbs[role], role, manifest);
    }
    return manifest;
  } finally {
    for (const db of Object.values(dbs)) db.close();
  }
}

export function adminSender(origin: string, token: string): Send {
  return async (path, body) => {
    const response = await fetch(new URL(`/__admin/${path}`, origin), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${path} answered ${response.status}: ${text}`);
    return JSON.parse(text);
  };
}

const USAGE =
  "Usage: transfer import <auth.sqlite> <service.sqlite> <backend-origin> (SAVVY_ADMIN_TOKEN set)\n       transfer restore <export.ndjson> <new-auth.sqlite> <new-service.sqlite>";

async function main(args: string[]) {
  if (args[0] === "import" && args.length === 4) {
    const token = process.env.SAVVY_ADMIN_TOKEN;
    if (!token) throw new Error("Set SAVVY_ADMIN_TOKEN");
    const { manifest, limits } = await importFiles(
      { auth: args[1]!, service: args[2]! },
      adminSender(args[3]!, token),
    );
    return { sealed: manifest.tables.length, limits };
  }
  if (args[0] === "restore" && args.length === 4) {
    const manifest = await restoreExport(args[1]!, {
      auth: args[2]!,
      service: args[3]!,
    });
    return { restored: manifest.tables.length, bookmark: manifest.bookmark };
  }
  throw new Error(USAGE);
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
