const WINDOW_MS = 300_000;
const LIMIT = 10_000;

/**
 * The provider and billing errors `deploy/savvy-monitor.py` counts from the
 * journal over the last five minutes. A Worker has no journal, so the log
 * sites count them here and the admin status route reads them.
 */
export const RECENT_ERRORS = [
  "reasoning_http_errors_5m",
  "transcription_provider_failures_5m",
  "billing_retries_5m",
  "reconcile_failures_5m",
] as const;
type Kind = (typeof RECENT_ERRORS)[number];

const seen = new Map<Kind, number[]>();

interface Store {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
}
let store: Store | null = null;

/** Keeps the window in `kv`, so a deploy or an evicted isolate does not reset it. */
export function persistErrorsIn(kv: Store) {
  store = kv;
  for (const kind of RECENT_ERRORS) {
    const times = kv.get(`recent-errors:${kind}`);
    if (Array.isArray(times))
      seen.set(
        kind,
        times.filter((at): at is number => typeof at === "number"),
      );
  }
}

export function noteError(kind: Kind, now = Date.now()) {
  const times = (seen.get(kind) ?? []).filter((at) => at >= now - WINDOW_MS);
  times.push(now);
  if (times.length > LIMIT) times.shift();
  seen.set(kind, times);
  store?.put(`recent-errors:${kind}`, times);
}

export function recentErrors(now = Date.now()) {
  return Object.fromEntries(
    RECENT_ERRORS.map((kind) => [
      kind,
      (seen.get(kind) ?? []).filter((at) => at >= now - WINDOW_MS).length,
    ]),
  ) as Record<Kind, number>;
}
