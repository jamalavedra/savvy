import {
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
} from "kysely";
import type { Db, RunResult, Statement, Transaction } from "./db.js";

type SqlValue = ArrayBuffer | string | number | null;
type Row = Record<string, SqlValue>;
interface SqlCursor {
  toArray(): Row[];
  readonly columnNames: string[];
}
/** The part of `DurableObjectState["storage"]` this adapter needs. */
export interface DoStorage {
  readonly sql: { exec(query: string, ...bindings: SqlValue[]): SqlCursor };
  transactionSync<T>(closure: () => T): T;
  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function bind(value: unknown): SqlValue {
  if (value === undefined) return null;
  if (typeof value === "bigint") {
    if (value > SAFE || value < -SAFE)
      throw new RangeError(
        `Cannot bind ${value}: Durable Object SQL stores integers beyond ±2^53 inexactly`,
      );
    return Number(value);
  }
  if (value === null || typeof value === "number" || typeof value === "string")
    return value;
  throw new TypeError(
    `Cannot bind ${typeof value === "object" ? "an object" : typeof value}: the adapter binds numbers, strings, bigints and null, without named parameters`,
  );
}

type QueryRow = Record<string, unknown>;

/**
 * better-sqlite3's surface, as `Db` describes it, over a SQLite-backed Durable
 * Object. Integers come back as Numbers, or as BigInts after
 * `defaultSafeIntegers(true)`. An integer beyond ±2^53, bound or read, throws:
 * Durable Object SQL converts at the boundary through a double, so every bound
 * number or BigInt reaches SQLite as REAL: `7 / ?` gives 3.5 and `'k:' || ?`
 * gives `k:5.0`. Keep bound integers out of arithmetic and string concatenation.
 */
export class DoSqlite implements Db {
  #safeIntegers = false;
  #depth = 0;
  #open = true;

  constructor(readonly storage: DoStorage) {}

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  defaultSafeIntegers(toggle = true): this {
    this.#safeIntegers = toggle;
    return this;
  }

  query(
    source: string,
    params: readonly unknown[],
  ): { rows: QueryRow[]; columnNames: string[] } {
    if (!this.#open) throw new TypeError("The database connection is not open");
    const cursor = this.storage.sql.exec(source, ...params.map(bind));
    const rows: QueryRow[] = cursor.toArray();
    for (const row of rows)
      for (const key in row) row[key] = this.#read(row[key] as SqlValue);
    return { rows, columnNames: cursor.columnNames };
  }

  lastChange(): RunResult {
    const [{ changes, rowid }] = this.query(
      "SELECT changes() AS changes, last_insert_rowid() AS rowid",
      [],
    ).rows as [{ changes: number | bigint; rowid: number | bigint }];
    return { changes: Number(changes), lastInsertRowid: rowid };
  }

  prepare<P extends unknown[] = unknown[], R = unknown>(
    source: string,
  ): Statement<P, R> {
    return {
      get: (...params) => this.query(source, params).rows[0] as R | undefined,
      all: (...params) => this.query(source, params).rows as R[],
      run: (...params) => {
        this.query(source, params);
        return this.lastChange();
      },
    };
  }

  transaction<A extends unknown[], R>(
    fn: (...args: A) => R,
  ): Transaction<A, R> {
    const run = (...args: A): R =>
      this.storage.transactionSync(() => {
        this.#depth++;
        try {
          return fn(...args);
        } finally {
          this.#depth--;
        }
      });
    return Object.assign(run, { immediate: run });
  }

  exec(source: string): this {
    this.query(source, []);
    return this;
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const pragma = source.trim();
    if (/^(journal_mode|busy_timeout|foreign_keys)\s*=/i.test(pragma))
      return options.simple ? undefined : [];
    if (
      !/^(foreign_keys|(table_info|foreign_key_list|foreign_key_check)\s*\(\s*'\w+'\s*\))$/i.test(
        pragma,
      )
    )
      throw new Error(
        `PRAGMA ${pragma} is not supported on Durable Object SQL. Supported: journal_mode, busy_timeout and foreign_keys assignments (ignored: Durable Objects use WAL and never wait on a lock, and a foreign_keys assignment takes effect only before an event's first write), reading foreign_keys, and table_info, foreign_key_list or foreign_key_check of one table`,
      );
    const { rows } = this.query(`PRAGMA ${pragma}`, []);
    return options.simple ? Object.values(rows[0] ?? {})[0] : rows;
  }

  close(): this {
    this.#open = false;
    return this;
  }

  #read(value: SqlValue): SqlValue | bigint {
    if (typeof value !== "number" || !Number.isInteger(value)) return value;
    if (!Number.isSafeInteger(value))
      throw new RangeError(
        `Durable Object SQL returned ${value}, beyond ±2^53, so its exact value is already lost`,
      );
    return this.#safeIntegers ? BigInt(value) : value;
  }
}

class DoSqliteConnection implements DatabaseConnection {
  #settle?: { commit(): void; rollback(reason: unknown): void };
  #done?: Promise<void>;

  constructor(private readonly db: DoSqlite) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const { rows, columnNames } = this.db.query(
      compiled.sql,
      compiled.parameters,
    );
    if (columnNames.length > 0) return { rows: rows as R[] };
    const { changes, lastInsertRowid } = this.db.lastChange();
    return {
      rows: [],
      numAffectedRows: BigInt(changes),
      insertId: BigInt(lastInsertRowid),
    };
  }

  async *streamQuery<R>(
    compiled: CompiledQuery,
  ): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(compiled);
  }

  async begin(): Promise<void> {
    if (this.#settle) throw new Error("A transaction is already open");
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => (entered = resolve));
    const done = this.db.storage.transaction(
      () =>
        new Promise<void>((commit, rollback) => {
          this.#settle = { commit, rollback };
          entered();
        }),
    );
    this.#done = done;
    await Promise.race([ready, done]);
  }

  async end(rollback?: Error): Promise<void> {
    const settle = this.#settle;
    if (!settle) throw new Error("No transaction is open");
    this.#settle = undefined;
    if (rollback) settle.rollback(rollback);
    else settle.commit();
    try {
      await this.#done;
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }
}

class DoSqliteDriver implements Driver {
  constructor(private readonly db: DoSqlite) {}
  async init() {}
  async acquireConnection() {
    return new DoSqliteConnection(this.db);
  }
  async beginTransaction(connection: DatabaseConnection) {
    await (connection as DoSqliteConnection).begin();
  }
  async commitTransaction(connection: DatabaseConnection) {
    await (connection as DoSqliteConnection).end();
  }
  async rollbackTransaction(connection: DatabaseConnection) {
    await (connection as DoSqliteConnection).end(
      new Error("Kysely transaction rolled back"),
    );
  }
  async releaseConnection() {}
  async destroy() {}
}

/**
 * Kysely over a `DoSqlite` handle. A Kysely transaction runs inside
 * `storage.transaction()`, so a rollback undoes its writes, and the object
 * takes no other request until it ends. A transaction open for 30 s resets the
 * object, so its callback must not wait on network I/O.
 */
export class DoSqliteDialect implements Dialect {
  constructor(private readonly db: DoSqlite) {}
  createDriver(): Driver {
    return new DoSqliteDriver(this.db);
  }
  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }
  createAdapter() {
    return new SqliteAdapter();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dialect's own signature
  createIntrospector(db: Kysely<any>) {
    return new SqliteIntrospector(db);
  }
}
