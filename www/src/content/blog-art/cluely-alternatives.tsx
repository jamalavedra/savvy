import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import { MONO, type PostArt } from "./types";

// The three things people want instead; the post argues for the third.
const WANTS = [
  { want: "A lower price", pick: "Pluely, Hedy" },
  { want: "Open source", pick: "Pluely, Savvy" },
];

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
    <div style={{ display: "flex", fontSize: 15, fontWeight: 800, color: "rgba(255,255,255,0.7)" }}>
      What you want instead
    </div>
    {WANTS.map((w) => (
      <div
        key={w.want}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 18px",
          borderRadius: 16,
          background: "rgba(255,255,255,0.14)",
          color: "rgba(255,255,255,0.88)",
          fontWeight: 700,
          fontSize: 17,
        }}
      >
        <div style={{ display: "flex" }}>{w.want}</div>
        <div style={{ display: "flex", color: "rgba(255,255,255,0.6)" }}>{w.pick}</div>
      </div>
    ))}
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "16px 18px",
        borderRadius: 18,
        background: C.surface,
        boxShadow: "0 30px 60px -30px rgba(0,0,0,0.55)",
        fontWeight: 700,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", fontSize: 21, color: C.fg, fontWeight: 800 }}>
          Answers from your files
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 14,
            color: C.success,
            background: "#e7f2e9",
            padding: "3px 10px",
            borderRadius: 999,
          }}
        >
          Savvy
        </div>
      </div>
      <div
        style={{ display: "flex", flexDirection: "column", marginTop: 12, gap: 6, fontSize: 16 }}
      >
        <div style={{ display: "flex", color: C.success }}>Say: the price on our sheet</div>
        <div style={{ display: "flex", color: C.danger }}>Avoid: an unapproved discount</div>
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 12,
          padding: "6px 10px",
          borderRadius: 8,
          background: C.inset,
          fontFamily: MONO,
          fontSize: 14,
          color: C.muted,
        }}
      >
        pricing-sheet.pdf
      </div>
    </div>
  </div>
);

const figure = (
  <Figure
    caption="A good reply to an objection is everywhere. Your price is written down in exactly one file."
    label="The other side asks: can you do better on price? Two overlay cards answer. The left one, from a general model, says stress value not discount, with a red question mark asking where that came from. The right one is fed by a folder of your documents through a brief and says the answer with the source, pricing sheet, underneath."
  >
    {/* the question */}
    <circle className="s" cx="300" cy="34" r="9" />
    <path
      className="s"
      d="M300 43 L300 70 M300 50 L286 62 M300 50 L314 62 M300 70 L290 88 M300 70 L310 88"
    />
    <path
      className="s"
      d="M330 20 Q332 0 420 2 Q520 2 520 26 Q520 48 430 48 L372 50 L354 62 L358 48 Q330 46 330 20 Z"
    />
    <text className="h" x="346" y="32">
      better on price?
    </text>

    {/* general overlay */}
    <path className="s" d="M260 96 Q160 110 150 140" markerEnd="url(#fig-arrow)" />
    <path
      className="s"
      d="M30 150 Q140 146 250 150 Q254 190 250 226 Q140 230 30 226 Q26 190 30 150 Z"
    />
    <text className="t" x="44" y="172">
      general overlay
    </text>
    <text className="h" x="44" y="206">
      stress value, not discount
    </text>
    <text className="h red" x="70" y="266">
      from where?
    </text>

    {/* grounded */}
    <path className="p" d="M340 96 Q440 110 450 140" markerEnd="url(#fig-arrow)" />
    <path
      className="p"
      d="M330 150 Q450 146 570 150 Q574 190 570 236 Q450 240 330 236 Q326 190 330 150 Z"
    />
    <text className="t" x="344" y="172">
      from your brief
    </text>
    <text className="h pen" x="344" y="204">
      quote the sheet price
    </text>
    <text className="t" x="344" y="226">
      source: pricing-sheet.pdf
    </text>
    <path
      className="s"
      d="M520 270 L540 270 L546 262 L572 262 L572 270 L590 270 L590 296 L520 296 Z"
    />
    <path className="s d" d="M546 258 Q540 250 540 244" markerEnd="url(#fig-arrow)" />
    <text className="t" textAnchor="end" x="510" y="290">
      your deal folder
    </text>
  </Figure>
);

export const art: PostArt = { tone: "night", cover, figure };
