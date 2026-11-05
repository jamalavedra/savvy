import type {
  MeetingEvent,
  MeetingSession,
  Recommendation,
  RecommendationTrigger,
  TranscriptTurn,
} from "../types";

export type ThinkingPhase = "checking" | "thinking";

export type ThinkingState = {
  trigger: RecommendationTrigger;
  /** Null while a manual request waits for the backend to assign a generation. */
  generationId: number | null;
  phase: ThinkingPhase;
};

export type GenerationCursor = {
  sessionId: string;
  generationId: number;
  sequence: number;
  terminalGenerationId: number;
};

type StaleCursor = Pick<
  GenerationCursor,
  "sessionId" | "generationId" | "sequence"
> &
  Partial<Pick<GenerationCursor, "terminalGenerationId">>;

export type MeetingEventEffect =
  | { kind: "ignored" }
  | { kind: "transcript"; cursor: GenerationCursor; turn: TranscriptTurn }
  | {
      kind: "started";
      cursor: GenerationCursor;
      thinking: {
        trigger: RecommendationTrigger;
        generationId: number;
        phase: ThinkingPhase;
      };
      card: Recommendation | null | undefined;
    }
  | { kind: "phase"; cursor: GenerationCursor; generationId: number }
  | {
      kind: "finished";
      cursor: GenerationCursor;
      recommendation: Recommendation | null;
    };

/**
 * Folds one backend meeting event into the generation cursor and says what the
 * UI should do about it. Every generation starts in the "checking" phase (the
 * model is reading notes and transcript) and moves to "thinking" once it begins
 * answering; a scan additionally leaves the current card alone (`card` is
 * undefined) until it has something to show.
 */
export function reduceMeetingEvent(
  current: GenerationCursor,
  event: MeetingEvent,
): MeetingEventEffect {
  if (meetingEventIsStale(event, current)) return { kind: "ignored" };
  const sameSession = event.sessionId === current.sessionId;
  if (event.type === "transcript") {
    return {
      kind: "transcript",
      cursor: {
        sessionId: event.sessionId,
        generationId: sameSession ? current.generationId : 0,
        sequence: event.sequence,
        terminalGenerationId: sameSession ? current.terminalGenerationId : 0,
      },
      turn: event.turn,
    };
  }
  if (event.type === "recommendationStarted") {
    const scan = event.trigger === "opportunity";
    return {
      kind: "started",
      cursor: {
        sessionId: event.sessionId,
        generationId: event.generationId,
        sequence: Math.max(current.sequence, event.sequence),
        terminalGenerationId: sameSession ? current.terminalGenerationId : 0,
      },
      thinking: {
        trigger: event.trigger,
        generationId: event.generationId,
        phase: "checking",
      },
      card: scan ? undefined : event.local,
    };
  }
  if (!sameSession) return { kind: "ignored" };
  if (event.type === "recommendationThinking") {
    return {
      kind: "phase",
      cursor: {
        ...current,
        sequence: Math.max(current.sequence, event.sequence),
      },
      generationId: event.generationId,
    };
  }
  return {
    kind: "finished",
    cursor: {
      sessionId: event.sessionId,
      generationId: event.generationId,
      sequence: Math.max(current.sequence, event.sequence),
      terminalGenerationId: Math.max(
        current.terminalGenerationId,
        event.generationId,
      ),
    },
    recommendation:
      event.type === "recommendationCompleted" ? event.recommendation : null,
  };
}

export function meetingEventIsStale(event: MeetingEvent, current: StaleCursor) {
  if (event.sessionId !== current.sessionId) return false;
  if (event.type === "transcript") return event.sequence <= current.sequence;
  if (event.type === "recommendationStarted") {
    return (
      event.generationId < current.generationId ||
      event.generationId <= (current.terminalGenerationId ?? 0) ||
      (event.generationId === current.generationId &&
        event.sequence <= current.sequence)
    );
  }
  return (
    event.generationId < current.generationId ||
    event.generationId <= (current.terminalGenerationId ?? 0)
  );
}

/**
 * Everything the live-meeting surface shows. `cursor.sessionId` is the meeting
 * whose events are accepted; it can be set before `session` when the first
 * transcript event beats the session event. `endedSessionId` rejects events
 * that arrive late from the meeting that just finished.
 */
export type MeetingState = {
  session: MeetingSession | null;
  stopped: boolean;
  endedSessionId: string | null;
  cursor: GenerationCursor;
  turns: TranscriptTurn[];
  thinking: ThinkingState | null;
  recommendation: Recommendation | null;
};

export type MeetingAction =
  | { type: "session"; session: MeetingSession }
  | { type: "stopped"; sessionId: string }
  | { type: "event"; event: MeetingEvent }
  | { type: "recommendationRequested" }
  | { type: "recommendationRequestFailed" }
  | { type: "thinkingExpired" };

export const idleMeeting: MeetingState = {
  session: null,
  stopped: false,
  endedSessionId: null,
  cursor: {
    sessionId: "",
    generationId: 0,
    sequence: 0,
    terminalGenerationId: 0,
  },
  turns: [],
  thinking: null,
  recommendation: null,
};

/**
 * Folds a backend event or the result of one of the app's own meeting
 * commands into the live-meeting state. Both windows run this over the same
 * events, so it depends on nothing outside its own state. Returns the same
 * object when the action is rejected.
 */
export function reduceMeeting(
  state: MeetingState,
  action: MeetingAction,
): MeetingState {
  switch (action.type) {
    case "session":
      return reduceSession(state, action.session);
    case "stopped":
      if (state.session?.id !== action.sessionId) return state;
      return { ...state, stopped: true, thinking: null };
    case "event":
      return reduceEvent(state, action.event);
    case "recommendationRequested":
      if (!state.session || state.stopped) return state;
      return {
        ...state,
        thinking: { trigger: "manual", generationId: null, phase: "checking" },
        recommendation: null,
      };
    case "recommendationRequestFailed":
      if (state.thinking?.generationId !== null) return state;
      return { ...state, thinking: null };
    case "thinkingExpired":
      if (!state.thinking) return state;
      return { ...state, thinking: null };
  }
}

function reduceSession(state: MeetingState, session: MeetingSession) {
  if (session.state === "preparing" || session.id === state.endedSessionId) {
    return state;
  }
  const current = state.cursor.sessionId === session.id;
  if (session.state === "completed" || session.state === "interrupted") {
    if (!current) return state;
    return { ...idleMeeting, endedSessionId: session.id };
  }
  const thinking = session.state === "paused" ? null : state.thinking;
  if (current) return { ...state, session, thinking };
  return {
    ...idleMeeting,
    session,
    endedSessionId: state.session?.id ?? state.endedSessionId,
    cursor: { ...idleMeeting.cursor, sessionId: session.id },
  };
}

function reduceEvent(state: MeetingState, event: MeetingEvent) {
  if (event.sessionId === state.endedSessionId) return state;
  if (state.cursor.sessionId && event.sessionId !== state.cursor.sessionId) {
    return state;
  }
  const effect = reduceMeetingEvent(state.cursor, event);
  switch (effect.kind) {
    case "ignored":
      return state;
    case "transcript":
      return {
        ...state,
        cursor: effect.cursor,
        turns: mergeTranscriptTurn(state.turns, effect.turn),
      };
    case "started":
      return {
        ...state,
        cursor: effect.cursor,
        thinking: effect.thinking,
        recommendation:
          effect.card === undefined ? state.recommendation : effect.card,
      };
    case "phase":
      return {
        ...state,
        cursor: effect.cursor,
        thinking:
          state.thinking && state.thinking.generationId === effect.generationId
            ? { ...state.thinking, phase: "thinking" as const }
            : state.thinking,
      };
    case "finished":
      return {
        ...state,
        cursor: effect.cursor,
        thinking: null,
        recommendation: effect.recommendation ?? state.recommendation,
      };
  }
}

export function mergeTranscriptTurn(
  turns: TranscriptTurn[],
  incoming: TranscriptTurn,
) {
  const current = liveTranscriptWindow(turns).filter(
    (turn) => turn.isFinal || turn.channel !== incoming.channel,
  );
  if (transcriptEncoder.encode(incoming.text).length > 8_192) return current;
  if (!incoming.isFinal) {
    const previousFinal = [...current]
      .reverse()
      .find((turn) => turn.isFinal && turn.channel === incoming.channel);
    if (previousFinal) {
      incoming = {
        ...incoming,
        text: withoutRepeatedPrefix(incoming.text, previousFinal.text),
      };
      if (!incoming.text) return current;
    }
  }
  turns = current;
  if (incoming.channel === "selfSpeaker") {
    if (echoCandidates(incoming, current, "other").length) return current;
  } else if (incoming.channel === "other") {
    const echoIds = new Set(
      echoCandidates(incoming, current, "selfSpeaker").map(
        (candidate) => candidate.id,
      ),
    );
    turns = current.filter((turn) => !echoIds.has(turn.id));
  } else {
    turns = current;
  }
  return liveTranscriptWindow(
    [...turns, incoming].sort(
      (left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
    ),
  );
}

const transcriptEncoder = new TextEncoder();

function liveTranscriptWindow(turns: TranscriptTurn[]) {
  let start = turns.length;
  let bytes = 0;
  // Saved history is read separately; this is only the live reconciliation window.
  while (start > Math.max(0, turns.length - 256)) {
    bytes += transcriptEncoder.encode(turns[start - 1].text).length;
    if (bytes > 256 * 1024) break;
    start--;
  }
  return turns.slice(start);
}

function withoutRepeatedPrefix(text: string, prefix: string) {
  const prefixWords = words(prefix);
  const matches = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  if (
    !prefixWords.length ||
    prefixWords.length > matches.length ||
    prefixWords.some((word, index) => word !== matches[index][0].toLowerCase())
  ) {
    return text;
  }
  const last = matches[prefixWords.length - 1];
  return text
    .slice((last.index ?? 0) + last[0].length)
    .replace(/^[\s,.;:!?…—-]+/u, "")
    .trim();
}

function echoCandidates(
  incoming: TranscriptTurn,
  turns: TranscriptTurn[],
  channel: TranscriptTurn["channel"],
) {
  const comparisonBudget = { remaining: 65_536 };
  const candidates = turns.filter(
    (turn) =>
      turn.channel === channel &&
      turn.sessionId === incoming.sessionId &&
      intervalGap(incoming, turn) <= 4_500,
  );
  const direct = candidates.filter((turn) =>
    transcriptTurnsMatch(incoming, turn, comparisonBudget),
  );
  if (direct.length || !candidates.length) return direct;
  const combined = {
    ...candidates[0],
    text: candidates.map((turn) => turn.text).join(" "),
    startMs: Math.min(...candidates.map((turn) => turn.startMs)),
    endMs: Math.max(...candidates.map((turn) => turn.endMs)),
  };
  return transcriptTurnsMatch(incoming, combined, comparisonBudget)
    ? candidates
    : [];
}

function transcriptTurnsMatch(
  left: TranscriptTurn,
  right: TranscriptTurn,
  budget: { remaining: number },
) {
  const leftWords = words(left.text);
  const rightWords = words(right.text);
  if (!leftWords.length || !rightWords.length) return false;
  const short = Math.min(leftWords.length, rightWords.length) <= 2;
  if (intervalGap(left, right) > (short ? 1_500 : 4_500)) return false;
  if (short) return leftWords.join(" ") === rightWords.join(" ");
  if (leftWords.join(" ") === rightWords.join(" ")) return true;
  const work = leftWords.length * rightWords.length;
  // ponytail: keep possible echoes when fuzzy matching exceeds this per-event
  // budget; use a bounded matching algorithm if long-form echo accuracy matters.
  if (work > budget.remaining) return false;
  budget.remaining -= work;
  return orderedCoverage(leftWords, rightWords) >= 0.7;
}

function words(text: string) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function orderedCoverage(left: string[], right: string[]) {
  let previous = Array(right.length + 1).fill(0) as number[];
  for (const leftWord of left) {
    const current = Array(right.length + 1).fill(0) as number[];
    right.forEach((rightWord, index) => {
      current[index + 1] =
        leftWord === rightWord
          ? previous[index] + 1
          : Math.max(current[index], previous[index + 1]);
    });
    previous = current;
  }
  return previous[right.length] / Math.min(left.length, right.length);
}

function intervalGap(left: TranscriptTurn, right: TranscriptTurn) {
  if (left.endMs < right.startMs) return right.startMs - left.endMs;
  if (right.endMs < left.startMs) return left.startMs - right.endMs;
  return 0;
}
