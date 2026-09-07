import type { CSSProperties } from "react";
import { PauseIcon } from "@/components/overlay/pieces";

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
  lifetime = "12s",
  className = "",
}: {
  rec: Rec;
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
          className="recommendation-dismiss auto-dismiss"
          style={{ "--recommendation-lifetime": lifetime } as CSSProperties}
          aria-hidden="true"
        >
          <span>Keep</span>
          <PauseIcon />
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
