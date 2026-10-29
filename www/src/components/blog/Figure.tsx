import type { ReactNode } from "react";

/**
 * Hand-drawn figure: an inline SVG plus a handwritten caption.
 * Classes: .s pencil, .p pen (pink, "the good path"), .r correction (red),
 * .g go (green), .d dashed; .h handwriting (+ .pen/.red/.go), .t small sans, .ah arrowhead.
 */
export function Figure({
  caption,
  label,
  viewBox = "0 0 600 300",
  children,
}: {
  caption: string;
  /** Accessible description of the drawing. */
  label: string;
  viewBox?: string;
  children: ReactNode;
}) {
  return (
    <figure className="fig">
      <svg role="img" aria-label={label} viewBox={viewBox}>
        <defs>
          <marker
            id="fig-arrow"
            markerHeight="7"
            markerWidth="7"
            orient="auto"
            refX="5"
            refY="3.5"
            viewBox="0 0 8 7"
          >
            <path className="ah" d="M0 0 L8 3.5 L0 7 Z" />
          </marker>
        </defs>
        {children}
      </svg>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
