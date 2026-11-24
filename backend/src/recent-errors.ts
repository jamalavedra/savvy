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

// ponytail: per isolate, so a deploy or eviction forgets the window; persist if the soak needs it.
const seen = new Map<Kind, number[]>();

export function noteError(kind: Kind, now = Date.now()) {
  const times = seen.get(kind) ?? [];
  times.push(now);
  if (times.length > LIMIT) times.shift();
  seen.set(kind, times);
}

export function recentErrors(now = Date.now()) {
  return Object.fromEntries(
    RECENT_ERRORS.map((kind) => [
      kind,
      (seen.get(kind) ?? []).filter((at) => at >= now - WINDOW_MS).length,
    ]),
  ) as Record<Kind, number>;
}
