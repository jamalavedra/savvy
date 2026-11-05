import { describe, expect, it } from "vitest";
import {
  idleMeeting,
  reduceMeeting,
  type MeetingAction,
  type MeetingState,
} from "./meetingEvents";
import type {
  MeetingEvent,
  MeetingSession,
  Recommendation,
  TranscriptTurn,
} from "../types";

function session(
  id: string,
  state: MeetingSession["state"] = "recording",
): MeetingSession {
  return {
    id,
    clientId: null,
    briefId: null,
    state,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    audioPath: null,
    contextPackHash: "pack",
    sourceIndexRevision: "sources",
  };
}

function turn(
  sessionId: string,
  text: string,
  startMs: number,
): TranscriptTurn {
  return {
    id: `${sessionId}-${startMs}`,
    sessionId,
    channel: "other",
    text,
    language: "en",
    startMs,
    endMs: startMs + 1_000,
    isFinal: true,
    confidence: 0.9,
  };
}

function transcript(
  sessionId: string,
  sequence: number,
  text = `turn ${sequence}`,
): MeetingEvent {
  return {
    type: "transcript",
    sessionId,
    sequence,
    turn: turn(sessionId, text, sequence * 2_000),
    interim: false,
  };
}

function started(
  sessionId: string,
  generationId: number,
  sequence = generationId,
): MeetingEvent {
  return {
    type: "recommendationStarted",
    sessionId,
    sequence,
    generationId,
    transcriptRevision: sequence,
    trigger: "question",
    local: null,
  };
}

function completed(
  sessionId: string,
  generationId: number,
  sequence = generationId,
): MeetingEvent {
  return {
    type: "recommendationCompleted",
    sessionId,
    sequence,
    generationId,
    transcriptRevision: sequence,
    recommendation: { id: `rec-${generationId}`, sessionId } as Recommendation,
  };
}

function run(actions: MeetingAction[], from: MeetingState = idleMeeting) {
  return actions.reduce(reduceMeeting, from);
}

const live = (id = "a") => run([{ type: "session", session: session(id) }]);

describe("reduceMeeting", () => {
  describe("legal transitions", () => {
    it("idle → recording on a live session", () => {
      const state = live();
      expect(state.session?.state).toBe("recording");
      expect(state.cursor.sessionId).toBe("a");
      expect(state.stopped).toBe(false);
    });

    it("recording → paused clears thinking, from Rust and from the command alike", () => {
      const thinking = run([{ type: "event", event: started("a", 1) }], live());
      expect(thinking.thinking?.generationId).toBe(1);
      const paused = run(
        [{ type: "session", session: session("a", "paused") }],
        thinking,
      );
      expect(paused.session?.state).toBe("paused");
      expect(paused.thinking).toBeNull();
      expect(paused.turns).toBe(thinking.turns);
    });

    it("paused → recording keeps the transcript and card", () => {
      const paused = run(
        [
          { type: "event", event: transcript("a", 1) },
          { type: "event", event: started("a", 1, 2) },
          { type: "event", event: completed("a", 1, 3) },
          { type: "session", session: session("a", "paused") },
        ],
        live(),
      );
      const resumed = run(
        [{ type: "session", session: session("a", "recording") }],
        paused,
      );
      expect(resumed.session?.state).toBe("recording");
      expect(resumed.turns).toHaveLength(1);
      expect(resumed.recommendation?.id).toBe("rec-1");
    });

    it("recording → stopped keeps the session visible and ends thinking", () => {
      const state = run(
        [
          { type: "event", event: started("a", 1) },
          { type: "stopped", sessionId: "a" },
        ],
        live(),
      );
      expect(state.stopped).toBe(true);
      expect(state.session?.id).toBe("a");
      expect(state.thinking).toBeNull();
    });

    it("stopped → idle on completion remembers the ended meeting", () => {
      const state = run(
        [
          { type: "event", event: transcript("a", 1) },
          { type: "stopped", sessionId: "a" },
          { type: "session", session: session("a", "completed") },
        ],
        live(),
      );
      expect(state).toEqual({ ...idleMeeting, endedSessionId: "a" });
    });

    it("recording → idle on interruption", () => {
      const state = run(
        [{ type: "session", session: session("a", "interrupted") }],
        live(),
      );
      expect(state.session).toBeNull();
      expect(state.endedSessionId).toBe("a");
    });

    it("keeps a transcript event that arrives before its session event", () => {
      const state = run([
        { type: "event", event: transcript("a", 1, "hello") },
        { type: "session", session: session("a") },
      ]);
      expect(state.turns.map((item) => item.text)).toEqual(["hello"]);
      expect(state.cursor.sequence).toBe(1);
    });

    it("applies the same session twice without losing anything", () => {
      const once = run([{ type: "event", event: transcript("a", 1) }], live());
      const twice = run([{ type: "session", session: session("a") }], once);
      expect(twice.turns).toBe(once.turns);
      expect(twice.cursor).toBe(once.cursor);
    });

    it("starts a different meeting fresh and forgets the previous one", () => {
      const state = run(
        [
          { type: "event", event: transcript("a", 1) },
          { type: "session", session: session("b") },
        ],
        live(),
      );
      expect(state.session?.id).toBe("b");
      expect(state.turns).toEqual([]);
      expect(state.endedSessionId).toBe("a");
    });

    it("tracks a recommendation from start through thinking to its card", () => {
      const checking = run([{ type: "event", event: started("a", 1) }], live());
      expect(checking.thinking).toEqual({
        trigger: "question",
        generationId: 1,
        phase: "checking",
      });
      const thinking = run(
        [
          {
            type: "event",
            event: {
              type: "recommendationThinking",
              sessionId: "a",
              sequence: 2,
              generationId: 1,
              transcriptRevision: 2,
            },
          },
        ],
        checking,
      );
      expect(thinking.thinking?.phase).toBe("thinking");
      const done = run(
        [{ type: "event", event: completed("a", 1, 3) }],
        thinking,
      );
      expect(done.thinking).toBeNull();
      expect(done.recommendation?.id).toBe("rec-1");
    });

    it("shows a manual request as thinking until the backend assigns a generation", () => {
      const requested = run([{ type: "recommendationRequested" }], live());
      expect(requested.thinking).toEqual({
        trigger: "manual",
        generationId: null,
        phase: "checking",
      });
      expect(requested.recommendation).toBeNull();
      const acknowledged = run(
        [{ type: "event", event: started("a", 1) }],
        requested,
      );
      expect(acknowledged.thinking?.generationId).toBe(1);
    });

    it("drops a manual request that the backend rejected", () => {
      const state = run(
        [
          { type: "recommendationRequested" },
          { type: "recommendationRequestFailed" },
        ],
        live(),
      );
      expect(state.thinking).toBeNull();
    });

    it("forgets thinking when the watchdog fires", () => {
      const state = run(
        [
          { type: "event", event: started("a", 1) },
          { type: "thinkingExpired" },
        ],
        live(),
      );
      expect(state.thinking).toBeNull();
    });
  });

  describe("rejected events", () => {
    it("ignores a late transcript from the meeting that just ended", () => {
      const next = run(
        [
          { type: "session", session: session("a", "completed") },
          { type: "session", session: session("b") },
          { type: "event", event: transcript("b", 1, "current") },
        ],
        live(),
      );
      const state = run(
        [{ type: "event", event: transcript("a", 7, "late") }],
        next,
      );
      expect(state).toBe(next);
    });

    it("ignores events from an unrelated meeting while one is live", () => {
      const current = run(
        [{ type: "event", event: transcript("a", 1) }],
        live(),
      );
      const state = run(
        [
          { type: "event", event: transcript("other", 1) },
          { type: "event", event: started("other", 5) },
          { type: "event", event: completed("other", 5) },
        ],
        current,
      );
      expect(state).toBe(current);
    });

    it("ignores a late event from the ended meeting while idle", () => {
      const idle = run(
        [{ type: "session", session: session("a", "completed") }],
        live(),
      );
      const state = run([{ type: "event", event: transcript("a", 9) }], idle);
      expect(state).toBe(idle);
    });

    it("ignores a late event from the ended meeting after the next one's first turn", () => {
      const early = run(
        [
          { type: "session", session: session("a", "completed") },
          { type: "event", event: transcript("b", 1, "early") },
        ],
        live(),
      );
      const state = run([{ type: "event", event: transcript("a", 9) }], early);
      expect(state).toBe(early);
      expect(state.turns.map((item) => item.text)).toEqual(["early"]);
    });

    it("ignores a stale live session for the meeting that already ended", () => {
      const idle = run(
        [{ type: "session", session: session("a", "completed") }],
        live(),
      );
      expect(
        run([{ type: "session", session: session("a", "paused") }], idle),
      ).toBe(idle);
    });

    it("ignores completion of a meeting it never saw", () => {
      const current = live();
      expect(
        run([{ type: "session", session: session("b", "completed") }], current),
      ).toBe(current);
    });

    it("ignores a preparing session", () => {
      const current = live();
      expect(
        run([{ type: "session", session: session("b", "preparing") }], current),
      ).toBe(current);
      expect(
        run([{ type: "session", session: session("b", "preparing") }]),
      ).toBe(idleMeeting);
    });

    it("ignores a stop for a different meeting", () => {
      const current = live();
      expect(run([{ type: "stopped", sessionId: "b" }], current)).toBe(current);
      expect(run([{ type: "stopped", sessionId: "a" }])).toBe(idleMeeting);
    });

    it("does not un-stop a meeting when its live session is re-sent", () => {
      const stopped = run([{ type: "stopped", sessionId: "a" }], live());
      const state = run([{ type: "session", session: session("a") }], stopped);
      expect(state.stopped).toBe(true);
    });

    it("rejects a manual request while idle or stopped", () => {
      expect(run([{ type: "recommendationRequested" }])).toBe(idleMeeting);
      const stopped = run([{ type: "stopped", sessionId: "a" }], live());
      expect(run([{ type: "recommendationRequested" }], stopped)).toBe(stopped);
    });

    it("keeps backend-driven thinking when a manual request failure arrives", () => {
      const thinking = run([{ type: "event", event: started("a", 1) }], live());
      expect(run([{ type: "recommendationRequestFailed" }], thinking)).toBe(
        thinking,
      );
    });

    it("ignores a replayed transcript sequence", () => {
      const current = run(
        [{ type: "event", event: transcript("a", 2) }],
        live(),
      );
      expect(run([{ type: "event", event: transcript("a", 2) }], current)).toBe(
        current,
      );
      expect(run([{ type: "event", event: transcript("a", 1) }], current)).toBe(
        current,
      );
    });

    it("ignores a thinking phase for a generation other than the current one", () => {
      const checking = run([{ type: "event", event: started("a", 2) }], live());
      const state = run(
        [
          {
            type: "event",
            event: {
              type: "recommendationThinking",
              sessionId: "a",
              sequence: 3,
              generationId: 1,
              transcriptRevision: 3,
            },
          },
        ],
        checking,
      );
      expect(state).toBe(checking);
    });
  });
});
