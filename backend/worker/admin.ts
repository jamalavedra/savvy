import { createHash, timingSafeEqual } from "node:crypto";
import { DoSqlite } from "../src/do-sqlite.ts";
import { requiredCapability } from "../src/rollback-preflight.ts";
import {
  differences,
  eventLine,
  byteLength,
  insertStatements,
  quoteName,
  scan,
  scanEvents,
  schemaStatements,
  type Manifest,
  type Query,
  type Value,
} from "../src/snapshot.ts";

export const ADMIN_PREFIX = "/__admin/";
export const SEALED = "import-sealed";
const IMPORT = "import-manifest";
const PART_BYTES = 8 * 1024 * 1024;

type Storage = DurableObjectStorage;
export interface AdminContext {
  storage: Storage;
  token: string | undefined;
  bucket: R2Bucket | undefined;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  sealed(): Promise<void>;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const digest = (text: string) => createHash("sha256").update(text).digest();

function authorize(request: Request, token: string | undefined) {
  if (!token)
    throw new Refusal(
      403,
      "admin_disabled",
      "Set the ADMIN_TOKEN secret to use admin routes",
    );
  const given = /^Bearer (.+)$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!given || !timingSafeEqual(digest(given[1]!), digest(token)))
    throw new Refusal(401, "unauthorized", "Wrong or missing admin token");
}

const query =
  (storage: Storage): Query =>
  (sql) =>
    storage.sql.exec(sql) as unknown as Iterable<
      Record<string, string | number | null>
    >;

function manifest(storage: Storage): Manifest {
  return {
    ...scan(query(storage)),
    requiredFundingSchema: requiredCapability(new DoSqlite(storage)),
  };
}

async function requireUnsealed(storage: Storage) {
  if (await storage.get(SEALED))
    throw new Refusal(409, "sealed", "This object is sealed; import refused");
}

async function begin({ storage }: AdminContext, expected: Manifest) {
  await requireUnsealed(storage);
  if (scan(query(storage)).schema.length > 0 || (await storage.get(IMPORT)))
    throw new Refusal(
      409,
      "not_empty",
      "Import needs an empty object; this one already has schema or an import",
    );
  storage.sql.exec("PRAGMA foreign_keys = OFF");
  storage.transactionSync(() => {
    for (const entry of schemaStatements(expected.schema, "tables"))
      storage.sql.exec(entry.sql!);
  });
  await storage.put(IMPORT, expected);
  return { tables: expected.tables.length };
}

async function rows(
  { storage }: AdminContext,
  body: { table: string; rows: Value[][] },
) {
  await requireUnsealed(storage);
  const expected = await storage.get<Manifest>(IMPORT);
  if (!expected)
    throw new Refusal(409, "no_import", "Begin an import before sending rows");
  const table = expected.tables.find((t) => t.name === body.table);
  if (!table)
    throw new Refusal(400, "unknown_table", `No table ${body.table} in import`);
  storage.sql.exec("PRAGMA foreign_keys = OFF");
  const stats = { statements: 0, maxSqlBytes: 0, maxParameters: 0 };
  storage.transactionSync(() => {
    for (const { sql, params } of insertStatements(
      table.name,
      table.columns,
      body.rows,
    )) {
      storage.sql.exec(sql, ...params);
      stats.statements++;
      stats.maxSqlBytes = Math.max(stats.maxSqlBytes, byteLength(sql));
      stats.maxParameters = Math.max(stats.maxParameters, params.length);
    }
  });
  return { rows: body.rows.length, ...stats };
}

function foreignKeyFaults(storage: Storage, tables: string[]) {
  return tables.filter(
    (name) =>
      storage.sql.exec(`PRAGMA foreign_key_check(${quoteName(name)})`).toArray()
        .length > 0,
  );
}

async function seal(context: AdminContext, expected: Manifest) {
  const { storage } = context;
  await requireUnsealed(storage);
  const pending = await storage.get<Manifest>(IMPORT);
  if (pending) {
    storage.sql.exec("PRAGMA foreign_keys = OFF");
    const existing = new Set(scan(query(storage)).schema.map((e) => e.name));
    storage.transactionSync(() => {
      for (const entry of schemaStatements(pending.schema, "rest"))
        if (!existing.has(entry.name)) storage.sql.exec(entry.sql!);
    });
  }
  const actual = manifest(storage);
  const found = [
    ...differences(expected, actual),
    ...foreignKeyFaults(
      storage,
      actual.tables.map((t) => t.name),
    ).map((name) => `foreign keys of ${name}`),
  ];
  if (found.length)
    throw new Refusal(
      409,
      "mismatch",
      `Seal refused; differs from the expected manifest in: ${found.join(", ")}`,
    );
  await storage.put(SEALED, { at: new Date().toISOString() });
  await storage.delete(IMPORT);
  await context.sealed();
  return actual;
}

class PartWriter {
  #parts: R2UploadedPart[] = [];
  #buffer: string[] = [];
  #size = 0;
  constructor(readonly upload: R2MultipartUpload) {}

  write(line: string) {
    this.#buffer.push(line, "\n");
    this.#size += line.length + 1;
  }

  async flush(final = false) {
    if (!final && this.#size < PART_BYTES) return;
    const body = new TextEncoder().encode(this.#buffer.join(""));
    this.#buffer = [];
    this.#size = 0;
    this.#parts.push(
      await this.upload.uploadPart(this.#parts.length + 1, body),
    );
  }

  complete() {
    return this.upload.complete(this.#parts);
  }
}

/**
 * Streams the export to R2 in 8 MiB parts, ending with the manifest line. The
 * object takes no other event until it ends, so the file is one consistent
 * snapshot; the 30 s limit of blockConcurrencyWhile bounds its size.
 */
async function exportToBucket(context: AdminContext) {
  const { storage, bucket } = context;
  if (!bucket)
    throw new Refusal(
      501,
      "no_bucket",
      "This Worker has no BACKUPS bucket binding",
    );
  return context.blockConcurrencyWhile(async () => {
    const bookmark = await storage.getCurrentBookmark();
    const createdAt = new Date().toISOString();
    const key = `exports/${createdAt}.ndjson`;
    const writer = new PartWriter(await bucket.createMultipartUpload(key));
    const events = scanEvents(query(storage));
    let step = events.next();
    for (; !step.done; step = events.next()) {
      writer.write(eventLine(step.value));
      await writer.flush();
    }
    const exported: Manifest = {
      ...step.value,
      createdAt,
      bookmark,
      requiredFundingSchema: requiredCapability(new DoSqlite(storage)),
    };
    writer.write(JSON.stringify({ manifest: exported }));
    await writer.flush(true);
    await writer.complete();
    return { key, manifest: exported };
  });
}

const routes: Record<string, (context: AdminContext, body: never) => unknown> =
  {
    "GET manifest": ({ storage }) => manifest(storage),
    "POST export": exportToBucket,
    "POST import/begin": begin,
    "POST import/rows": rows,
    "POST seal": seal,
  };

export async function admin(context: AdminContext, request: Request) {
  try {
    authorize(request, context.token);
    const path = new URL(request.url).pathname.slice(ADMIN_PREFIX.length);
    const route = routes[`${request.method} ${path}`];
    if (!route) throw new Refusal(404, "not_found", `No admin route ${path}`);
    const body = request.method === "POST" ? await request.text() : "";
    return Response.json(
      await route(context, (body ? JSON.parse(body) : undefined) as never),
    );
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
}
