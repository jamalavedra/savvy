"use client";

import { useEffect, useState } from "react";
import {
  BaseBar,
  type Status,
  StatusLine,
  TranscriptPane,
  type Turn,
} from "@/components/overlay/pieces";
import { type Rec, RecommendationCard } from "@/components/overlay/RecommendationCard";
import "./overlay.css";

export type OverlayState = {
  turns: Turn[];
  status: Status;
  rec: Rec | null;
  paused?: boolean;
};

/** One step of a scripted playback. States are cumulative: each step's
 *  fields are merged over the previous state. Step 0 must be complete. */
export type ScriptStep = { at: number; state: Partial<OverlayState> };

/** The card itself, driven entirely by `state`. Class toggles mirror the
 *  app: `.open` widens to 392px, `.has-text`/`.ai-open` grow the rows. */
export function OverlayView({
  state,
  elapsed,
  dark = false,
}: {
  state: OverlayState;
  elapsed: number;
  dark?: boolean;
}) {
  const hasText = state.turns.length > 0;
  const aiOpen = state.rec !== null;
  const open = hasText || aiOpen;
  return (
    <div className={`sv sv-overlay ${dark ? "sv-dark" : ""}`}>
      <section
        className={`scard ${open ? "open" : ""} ${hasText ? "has-text" : ""} ${
          aiOpen ? "ai-open" : ""
        } ${state.paused ? "paused" : ""}`}
        aria-label="Savvy meeting overlay"
      >
        <div className="stext">
          <div className="stext-clip">
            <TranscriptPane turns={state.turns} />
          </div>
        </div>
        <div className="ai-extension">
          <div className="ai-extension-clip">
            {state.rec && <RecommendationCard rec={state.rec} autoDismiss lifetime="9s" />}
          </div>
        </div>
        <StatusLine status={state.status} advice={hasText} />
        <BaseBar elapsed={elapsed} paused={state.paused} />
      </section>
    </div>
  );
}

function stateAt(script: ScriptStep[], index: number): OverlayState {
  let state: OverlayState = { turns: [], status: "listening", rec: null };
  for (const step of script.slice(0, index + 1)) state = { ...state, ...step.state };
  return state;
}

/** Plays a script in a loop. Under reduced motion it shows `restIndex`
 *  (default: the last step that has a recommendation) and never animates. */
export function ScriptedOverlay({
  script,
  restIndex,
  startElapsed = 0,
  dark = false,
}: {
  script: ScriptStep[];
  restIndex?: number;
  /** Timer value at the start of each loop, in seconds. */
  startElapsed?: number;
  dark?: boolean;
}) {
  const [state, setState] = useState<OverlayState>(() => stateAt(script, 0));
  const [elapsed, setElapsed] = useState(startElapsed);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const rest =
        restIndex ??
        Math.max(
          0,
          script.findLastIndex((step) => step.state.rec),
        );
      setState(stateAt(script, rest));
      return;
    }
    const last = script[script.length - 1];
    const total = (last?.at ?? 0) + 1200;
    let timers: number[] = [];
    const run = () => {
      setElapsed(startElapsed);
      timers = script.map((step) =>
        window.setTimeout(() => setState((s) => ({ ...s, ...step.state })), step.at),
      );
      timers.push(window.setTimeout(run, total));
    };
    run();
    const tick = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      window.clearInterval(tick);
    };
  }, [script, restIndex, startElapsed]);

  return <OverlayView state={state} elapsed={elapsed} dark={dark} />;
}
