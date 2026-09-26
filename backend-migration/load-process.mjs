// Test-only entry point. Observe committed audio without adding production metrics.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { state } from "../backend/build/server.js";
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const sessions = new Map();
const originalSet = state.sessions.set.bind(state.sessions);
state.sessions.set = (id, live) => {
  const seen = sessions.get(id) ?? {
    sources: new Map(),
    end: 0n,
    union: 0n,
    frames: 0,
  };
  for (const [name, source] of live.sources) {
    const previous = seen.sources.get(name) ?? 0n;
    if (source.audioEndUnits <= previous) continue;
    const start = source.lastAudioMs;
    const base = start * 32n + (previous % 32n);
    const expected = (previous > base ? previous : base) + 1600n;
    assert.equal(
      source.audioEndUnits,
      expected,
      "each committed frame is exactly 50ms PCM",
    );
    const end = expected / 32n;
    if (end > seen.end) {
      seen.union += end - (start > seen.end ? start : seen.end);
      seen.end = end;
    }
    seen.sources.set(name, expected);
    seen.frames++;
  }
  sessions.set(id, seen);
  return originalSet(id, live);
};
process.on("exit", () => {
  delay.disable();
  writeFileSync(
    process.env.SAVVY_LOAD_METRICS,
    JSON.stringify(
      {
        eventLoopP99Ms: delay.percentile(99) / 1e6,
        sessions: [...sessions].map(([id, value]) => ({
          id: Number(id),
          unionMs: Number(value.union),
          frames: value.frames,
        })),
      },
      null,
      2,
    ),
  );
});
