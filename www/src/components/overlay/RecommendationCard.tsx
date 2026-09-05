import type { CSSProperties } from "react";
import { PauseIcon, XIcon } from "@/components/overlay/pieces";

// The Say / Avoid card, as rendered by RecommendationPreview in the app.
// CARD_TITLES there: question → Answer, risk → Red line, manual → Advice,
// opportunity → Savvy noticed.

export type Rec = {
  title: "Answer" | "Red line" | "Advice" | "Savvy noticed";
  say: string;
  avoid?: string;
  /** 0–100, rendered as "N% grounded". */
  grounded: number;
  /** Relative path of the first cited source; briefs read "brief · Red lines". */
  source?: string;
};

export function RecommendationCard({
  rec,
  autoDismiss = false,
  lifetime = "12s",
  className = "",
}: {
  rec: Rec;
  /** Shows the expiry progress behind "Keep", like a fresh card in the app. */
  autoDismiss?: boolean;
  lifetime?: string;
  className?: string;
}) {
  return (
    <section className={`recommendation-card ${className}`}>
      <div className="recommendation-top">
        <span className="recommendation-title">
          <i /> {rec.title}
        </span>
        <span
          className={`recommendation-dismiss ${autoDismiss ? "auto-dismiss" : ""}`}
          style={{ "--recommendation-lifetime": lifetime } as CSSProperties}
          aria-hidden="true"
        >
          <span>{autoDismiss ? "Keep" : "Dismiss"}</span>
          {autoDismiss ? <PauseIcon /> : <XIcon />}
        </span>
      </div>
      <div className="say-block">
        <span>Say</span>
        <div className="recommendation-copy">
          <p>{rec.say}</p>
          <small className="grounded-score">{rec.grounded}% grounded</small>
        </div>
      </div>
      {rec.avoid && (
        <div className="avoid-block">
          <span>Avoid</span>
          <p>{rec.avoid}</p>
        </div>
      )}
      {rec.source && (
        <span className="source-button">
          <span className="source-path">⌁ {rec.source}</span>
          <span>↗</span>
        </span>
      )}
    </section>
  );
}
