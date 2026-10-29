import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import type { PostArt } from "./types";

// Three triggers and one scan; every other moment is a skip.
const TRIGGERS = ["They asked a question", "Someone touched a red line", "You pressed Advice"];

const cover = (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      width: 440,
      height: 400,
      gap: 12,
      justifyContent: "center",
    }}
  >
    {TRIGGERS.map((t, i) => (
      <div
        key={t}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          borderRadius: 16,
          background: "rgba(255,255,255,0.6)",
          color: C.fg,
          fontWeight: 700,
          fontSize: 17,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            borderRadius: 999,
            background: C.fg,
            color: "#fff",
            fontSize: 14,
          }}
        >
          {i + 1}
        </div>
        <div style={{ display: "flex" }}>{t}</div>
      </div>
    ))}
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "16px 18px",
        borderRadius: 18,
        background: C.surface,
        boxShadow: "0 30px 60px -30px rgba(60,30,10,0.55)",
        fontWeight: 700,
      }}
    >
      <div style={{ display: "flex" }}>
        <div
          style={{
            display: "flex",
            fontSize: 14,
            color: C.muted,
            background: C.inset,
            padding: "3px 10px",
            borderRadius: 999,
          }}
        >
          Everything else
        </div>
      </div>
      <div style={{ display: "flex", marginTop: 10, fontSize: 24, color: C.fg }}>
        Skip. Silence is the default.
      </div>
    </div>
  </div>
);

// 260px per 1.0 of score, bar base at y=300: 0.45 → 183, 0.55 → 157, 0.70 → 118, 0.95 → 53, 1.0 → 40.
const figure = (
  <Figure
    caption="Without a cited file, a card needs transcript confidence of at least 0.4 just to clear the line."
    label="A hand-drawn stacked bar for the grounding score. A base block of 0.45, then up to 0.25 for transcription confidence, 0.25 for citing one of your documents, and 0.05 for a deterministic red-line match, capped at 1.0. A red dashed line at 0.55 is labelled: below this, automatic cards are rejected; manual Advice is exempt."
    viewBox="0 0 600 320"
  >
    <path className="s" d="M150 300 Q280 302 420 300" />
    <path className="s" d="M230 300 L230 183 Q280 185 330 183 L330 300" />
    <text className="h" textAnchor="middle" x="280" y="250">
      0.45
    </text>
    <text className="t" textAnchor="middle" x="280" y="270">
      start
    </text>
    <path className="s d" d="M230 183 L230 118 Q280 120 330 118 L330 183" />
    <path className="p" d="M230 118 L230 53 Q280 55 330 53 L330 118" />
    <path className="s" d="M230 53 L230 40 Q280 42 330 40 L330 53" />

    <text className="h" x="346" y="140">
      + 0.25 × confidence
    </text>
    <text className="h pen" x="346" y="92">
      + 0.25 cites your file
    </text>
    <text className="h" x="346" y="44">
      + 0.05 red line
    </text>
    <text className="t" x="346" y="20">
      capped at 1.0
    </text>

    <path className="r d" d="M110 157 Q240 155 440 157" />
    <text className="h red" textAnchor="end" x="100" y="163">
      0.55
    </text>
    <text className="t" x="20" y="190">
      below: automatic
    </text>
    <text className="t" x="20" y="208">
      cards are rejected
    </text>
    <text className="t" x="20" y="232">
      (manual Advice is exempt)
    </text>
  </Figure>
);

export const art: PostArt = { tone: "paper", cover, figure };
