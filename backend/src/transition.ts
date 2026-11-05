import type { Db } from "./db.js";

/**
 * Allowed state changes per lifecycle table, written as `from -> to[]`.
 * A row may also be rewritten in its current state when the caller lists that
 * state in `from`; the edge table governs changes only.
 */
export const LIFECYCLES = {
  checkouts: {
    column: "state",
    edges: {
      pending: ["payment_pending", "complete", "failed", "expired"],
      payment_pending: ["complete", "failed", "expired"],
      failed: ["complete"],
      complete: [],
      expired: [],
    },
  },
  organization_checkouts: {
    column: "state",
    edges: {
      pending: ["unknown", "payment_pending", "complete", "failed", "expired"],
      unknown: ["pending", "payment_pending", "complete", "failed", "expired"],
      payment_pending: ["complete", "failed", "expired"],
      failed: ["complete"],
      complete: [],
      expired: [],
    },
  },
  organization_quantity_changes: {
    column: "state",
    edges: {
      pending: ["unknown", "applied", "failed"],
      unknown: ["applied", "failed"],
      applied: [],
      failed: [],
    },
  },
  managed_sessions: {
    column: "state",
    edges: {
      active: ["paused", "stopped"],
      paused: ["active", "stopped"],
      stopped: [],
    },
  },
  provider_requests: {
    column: "state",
    edges: { pending: ["succeeded", "failed"], succeeded: [], failed: [] },
  },
  billing_events: {
    column: "status",
    edges: {
      pending: ["processed", "ignored", "rejected"],
      processed: [],
      ignored: [],
      rejected: [],
    },
  },
} as const;

/** Why a managed session is paused; NULL while it is not. */
export const PAUSE_REASONS = [
  "user",
  "exhausted",
  "provider_failure",
  "disconnected",
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export type Lifecycle = keyof typeof LIFECYCLES;
export type StateOf<T extends Lifecycle> =
  keyof (typeof LIFECYCLES)[T]["edges"] & string;

export function states<T extends Lifecycle>(table: T): StateOf<T>[] {
  return Object.keys(LIFECYCLES[table].edges) as StateOf<T>[];
}

/**
 * Moves rows matched by `where` to `to`, but only rows currently in one of the
 * `from` states. Every `from -> to` pair must be an allowed edge or a rewrite
 * of the current state; anything else is a programming error and throws.
 * `set` adds further columns after the state column; `params` are the bound
 * values of `set` and `where` in textual order. Returns whether a row changed.
 */
export function transition<T extends Lifecycle>(
  db: Db,
  table: T,
  from: readonly StateOf<T>[],
  to: StateOf<T>,
  clause: { set?: string; where: string; params: readonly unknown[] },
): boolean {
  const { column, edges } = LIFECYCLES[table];
  const allowed = edges as Record<string, readonly string[]>;
  if (!(to in allowed))
    throw new Error(`Unknown ${table} state ${JSON.stringify(to)}`);
  if (from.length === 0)
    throw new Error(`Transition to ${table}.${to} needs a from-state`);
  for (const state of from)
    if (state !== to && !allowed[state]?.includes(to))
      throw new Error(`Illegal ${table} transition ${state} -> ${to}`);
  const set = clause.set ? `,${clause.set}` : "";
  const placeholders = from.map(() => "?").join(",");
  return (
    db
      .prepare(
        `UPDATE ${table} SET ${column}=?${set} WHERE (${clause.where}) AND ${column} IN (${placeholders})`,
      )
      .run(to, ...clause.params, ...from).changes > 0
  );
}
