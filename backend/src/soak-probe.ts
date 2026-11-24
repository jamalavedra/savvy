import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const POLL_MS = 60_000;
const ALARM_LAG_MS = 180_000;

export interface Status {
  alarmAtMs: number | null;
  lastAlarmAtMs: number | null;
  failures: string[];
}

/** Names what is wrong in one poll; an empty list is a healthy poll. */
export function problems(
  ready: number | string,
  status: Status | string,
  now: number,
) {
  const found: string[] = [];
  if (ready !== 200) found.push(`ready_${ready}`);
  if (typeof status === "string") return [...found, `status_${status}`];
  found.push(...status.failures);
  if (status.alarmAtMs === null) found.push("alarm_unset");
  else if (now - status.alarmAtMs > ALARM_LAG_MS) found.push("alarm_overdue");
  if (
    status.lastAlarmAtMs === null ||
    now - status.lastAlarmAtMs > ALARM_LAG_MS
  )
    found.push("alarm_lag");
  return found;
}

async function poll(origin: string, token: string) {
  const signal = AbortSignal.timeout(15_000);
  const ready = await fetch(`${origin}/ready`, { signal }).then(
    async (response) => (await response.body?.cancel(), response.status),
    (error: unknown) => `unreachable:${String(error)}`,
  );
  const status = await fetch(`${origin}/__admin/status`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  }).then(
    async (response) =>
      response.ok
        ? ((await response.json()) as Status & Record<string, unknown>)
        : (await response.body?.cancel(), String(response.status)),
    (error: unknown) => `unreachable:${String(error)}`,
  );
  const now = Date.now();
  const found = problems(ready, status, now);
  return {
    at: new Date(now).toISOString(),
    ok: found.length === 0,
    problems: found,
    ready,
    status,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  const [url, ...extra] = process.argv.slice(2);
  const token = process.env.ADMIN_TOKEN;
  if (!url || extra.length || !token) {
    console.error("Usage: ADMIN_TOKEN=<token> soak-probe <https://origin>");
    process.exitCode = 2;
  } else {
    const origin = new URL(url).origin;
    for (;;) {
      console.log(JSON.stringify(await poll(origin, token)));
      await sleep(POLL_MS);
    }
  }
}
