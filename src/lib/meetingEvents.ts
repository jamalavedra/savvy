import type { MeetingEvent, MeetingSession, TranscriptTurn } from "../types";

type GenerationCursor = {
  sessionId: string;
  generationId: number;
  sequence: number;
  terminalGenerationId?: number;
};

export function meetingEventIsStale(
  event: MeetingEvent,
  current: GenerationCursor,
) {
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

export function startsNewMeeting(
  session: Pick<MeetingSession, "id" | "state">,
  currentSessionId: string,
) {
  return (
    (session.state === "recording" || session.state === "paused") &&
    session.id !== currentSessionId
  );
}

export function mergeTranscriptTurn(
  turns: TranscriptTurn[],
  incoming: TranscriptTurn,
) {
  const current = turns.filter(
    (turn) => turn.isFinal || turn.channel !== incoming.channel,
  );
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
  return [...turns, incoming].sort(
    (left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
  );
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
  const candidates = turns.filter(
    (turn) =>
      turn.channel === channel &&
      turn.sessionId === incoming.sessionId &&
      intervalGap(incoming, turn) <= 4_500,
  );
  const direct = candidates.filter((turn) =>
    transcriptTurnsMatch(incoming, turn),
  );
  if (direct.length || !candidates.length) return direct;
  const combined = {
    ...candidates[0],
    text: candidates.map((turn) => turn.text).join(" "),
    startMs: Math.min(...candidates.map((turn) => turn.startMs)),
    endMs: Math.max(...candidates.map((turn) => turn.endMs)),
  };
  return transcriptTurnsMatch(incoming, combined) ? candidates : [];
}

function transcriptTurnsMatch(left: TranscriptTurn, right: TranscriptTurn) {
  const leftWords = words(left.text);
  const rightWords = words(right.text);
  if (!leftWords.length || !rightWords.length) return false;
  const short = Math.min(leftWords.length, rightWords.length) <= 2;
  if (intervalGap(left, right) > (short ? 1_500 : 4_500)) return false;
  if (short) return leftWords.join(" ") === rightWords.join(" ");
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
