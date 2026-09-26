import { useCallback, useEffect, useRef, useState } from "react";
import {
  getMeetingTranscriptPage,
  openMeetingRecording,
  openMeetingTranscript,
} from "./lib/api";
import type { MeetingHistoryItem, TranscriptTurn } from "./types";

export function MeetingDetails({
  meeting,
  onBack,
}: {
  meeting: MeetingHistoryItem;
  onBack: () => void;
}) {
  const [page, setPage] = useState<{
    offset: number;
    turns: TranscriptTurn[];
    more: boolean;
  }>({ offset: 0, turns: [], more: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef({ generation: 0 });
  const heading = useRef<HTMLHeadingElement>(null);
  const sessionId = meeting.session.id;
  const load = useCallback(
    async (offset: number) => {
      const current = ++request.current.generation;
      try {
        const turns = await getMeetingTranscriptPage(sessionId, offset);
        if (current === request.current.generation)
          setPage({
            offset,
            turns: turns.slice(0, 50),
            more: turns.length > 50,
          });
      } catch (reason) {
        if (current === request.current.generation) setError(String(reason));
      } finally {
        if (current === request.current.generation) setLoading(false);
      }
    },
    [sessionId],
  );
  useEffect(() => {
    heading.current?.focus();
    const pending = request.current;
    const current = ++pending.generation;
    void getMeetingTranscriptPage(sessionId, 0)
      .then((turns) => {
        if (current === pending.generation)
          setPage({
            offset: 0,
            turns: turns.slice(0, 50),
            more: turns.length > 50,
          });
      })
      .catch((reason: unknown) => {
        if (current === pending.generation) setError(String(reason));
      })
      .finally(() => {
        if (current === pending.generation) setLoading(false);
      });
    return () => {
      pending.generation++;
    };
  }, [sessionId]);
  const changePage = (offset: number) => {
    setLoading(true);
    setError(null);
    void load(offset);
  };
  const open = async (action: (id: string) => Promise<void>) => {
    setError(null);
    try {
      await action(sessionId);
    } catch (reason) {
      setError(String(reason));
    }
  };
  const started = new Date(meeting.session.startedAt);
  const duration = meeting.session.endedAt
    ? Math.max(
        0,
        Math.round(
          (new Date(meeting.session.endedAt).getTime() - started.getTime()) /
            60000,
        ),
      )
    : null;
  return (
    <div className="page-content meeting-details">
      <header>
        <h2 ref={heading} tabIndex={-1}>
          {meeting.clientName}
        </h2>
        <p>
          {started.toLocaleDateString()} · {duration ?? "—"} min · Saved locally
        </p>
      </header>
      {error && (
        <div role="alert" className="settings-error">
          <p>{error}</p>
          <button
            className="button"
            disabled={loading}
            onClick={() => changePage(page.offset)}
          >
            Retry transcript
          </button>
        </div>
      )}
      <section
        className="group-card meeting-details-transcript"
        aria-label="Transcript"
        aria-busy={loading}
      >
        <h3>Transcript</h3>
        {loading && <p role="status">Loading transcript…</p>}
        {!loading && !error && page.turns.length === 0 && (
          <p>No transcript was saved for this meeting.</p>
        )}
        <ol>
          {page.turns.map((turn) => (
            <li key={turn.id}>
              <time>
                {Math.floor(turn.startMs / 60000)
                  .toString()
                  .padStart(2, "0")}
                :
                {Math.floor((turn.startMs / 1000) % 60)
                  .toString()
                  .padStart(2, "0")}
              </time>
              <div>
                <strong>
                  {turn.channel === "selfSpeaker"
                    ? "You"
                    : turn.channel === "other"
                      ? "Other speaker"
                      : "Unknown speaker"}
                </strong>
                <p>{turn.text}</p>
              </div>
            </li>
          ))}
        </ol>
        {(page.offset > 0 || page.more) && (
          <nav
            aria-label="Transcript pages"
            className="meeting-details-actions"
          >
            <button
              className="button"
              disabled={loading || page.offset === 0}
              onClick={() => changePage(Math.max(0, page.offset - 50))}
            >
              Previous
            </button>
            <span aria-live="polite">
              Page {Math.floor(page.offset / 50) + 1}
            </span>
            <button
              className="button"
              disabled={loading || !page.more}
              onClick={() => changePage(page.offset + 50)}
            >
              Next
            </button>
          </nav>
        )}
      </section>
      <div className="meeting-details-actions">
        <button
          className="button primary"
          onClick={() => void open(openMeetingTranscript)}
        >
          Open transcript
        </button>
        <button
          className="button"
          disabled={!meeting.session.audioPath}
          onClick={() => void open(openMeetingRecording)}
        >
          Show recording
        </button>
      </div>
      {!meeting.session.audioPath && <p>Recording is unavailable.</p>}
      <button className="button" onClick={onBack}>
        Back to history
      </button>
    </div>
  );
}
