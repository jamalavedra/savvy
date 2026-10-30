import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import { MONO, type PostArt } from "./types";

// Four products share one label; only the last row cites a file.
const ROWS = [
  { kind: "Live transcript", out: "“twenty five percent”" },
  { kind: "Live summary", out: "Pricing was discussed" },
  { kind: "Generic coach", out: "Anchor high, ask timeline" },
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
    {ROWS.map((r) => (
      <div
        key={r.kind}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 18px",
          borderRadius: 16,
          background: "rgba(255,255,255,0.14)",
          color: "rgba(255,255,255,0.85)",
          fontWeight: 700,
          fontSize: 17,
        }}
      >
        <div style={{ display: "flex" }}>{r.kind}</div>
        <div style={{ display: "flex", color: "rgba(255,255,255,0.6)" }}>{r.out}</div>
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
          Grounded in your files
        </div>
        <div style={{ display: "flex", fontFamily: MONO, fontSize: 14, color: C.muted }}>94%</div>
      </div>
      <div style={{ display: "flex", marginTop: 10, fontSize: 22, color: C.fg }}>
        Cap is 15%. Beyond that, finance signs.
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 10,
          padding: "6px 10px",
          borderRadius: 8,
          background: C.inset,
          fontFamily: MONO,
          fontSize: 13,
          color: C.muted,
        }}
      >
        pricing-sheet.pdf · p.3
      </div>
    </div>
  </div>
);

const figure = (
  <Figure
    caption="Same question, four products. Three describe the call; one answers it."
    label="A stick figure asks: 25% off for three years? Four arrows lead to four answers: a transcript, a summary, a coaching tip, and a circled card citing the pricing sheet, labelled changes what you say."
  >
    <circle className="s" cx="70" cy="128" r="9" />
    <path
      className="s"
      d="M70 137 L70 166 M70 144 L54 158 M70 144 L86 158 M70 166 L56 188 M70 166 L84 188"
    />
    <path
      className="s"
      d="M30 92 Q28 52 90 50 L150 49 Q178 51 176 74 Q174 98 146 96 L96 98 L82 112 L84 96 Q32 98 30 92 Z"
    />
    <text className="h" x="46" y="80">
      25% off, 3 yrs?
    </text>
    <text className="t" textAnchor="middle" x="70" y="210">
      the buyer
    </text>

    <path className="s" d="M190 120 Q260 60 330 52" markerEnd="url(#fig-arrow)" />
    <path className="s" d="M192 132 Q260 112 330 112" markerEnd="url(#fig-arrow)" />
    <path className="s" d="M192 144 Q260 160 330 172" markerEnd="url(#fig-arrow)" />
    <path className="p" d="M190 156 Q250 220 330 236" markerEnd="url(#fig-arrow)" />

    <text className="h" x="344" y="58">
      &quot;twenty five percent&quot;
    </text>
    <text className="h" x="344" y="118">
      pricing was discussed
    </text>
    <text className="h" x="344" y="178">
      anchor high!
    </text>
    <path className="p" d="M336 216 Q470 206 588 220 Q594 256 470 262 Q340 264 336 240 Z" />
    <text className="h pen" x="350" y="246">
      cap is 15%, see pricing.pdf
    </text>
    <text className="t" x="350" y="286">
      the only one that changes what you say
    </text>
  </Figure>
);

export const art: PostArt = { tone: "dusk", cover, figure };
