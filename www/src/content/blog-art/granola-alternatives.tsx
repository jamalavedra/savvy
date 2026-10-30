import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import { MONO, type PostArt } from "./types";

// Four reasons to leave, each routed to its answer; the live one is the card.
const ROWS = [
  { why: "Shared team record", to: "a bot" },
  { why: "Platform or language", to: "hard constraint" },
  { why: "Read the code", to: "MIT, free" },
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
        key={r.why}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 18px",
          borderRadius: 16,
          background: "rgba(255,255,255,0.62)",
          color: C.fg,
          fontWeight: 700,
          fontSize: 17,
        }}
      >
        <div style={{ display: "flex" }}>{r.why}</div>
        <div style={{ display: "flex", color: C.muted }}>{r.to}</div>
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
            color: C.pinkDeep,
            background: C.pinkLight,
            padding: "3px 10px",
            borderRadius: 999,
          }}
        >
          During the call
        </div>
        <div style={{ display: "flex", fontSize: 14, color: C.muted }}>not after it</div>
      </div>
      <div style={{ display: "flex", marginTop: 10, fontSize: 22, color: C.fg }}>
        What to say, what to avoid
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 10,
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
    caption="Same meeting, different moment of payoff: one after you hang up, one while the answer can still change."
    label="A timeline split into before, during and after the call, with two lanes. Granola: nothing before, you type during, clean notes after. Savvy: a brief built from your files before, a pink card saying what to say and which file during, and no team record after."
  >
    <path className="s" d="M110 58 Q340 54 588 58" markerEnd="url(#fig-arrow)" />
    <text className="h" x="138" y="42">
      before
    </text>
    <text className="h" x="300" y="42">
      during
    </text>
    <text className="h" x="478" y="42">
      after
    </text>
    <path className="s d" d="M240 70 Q242 170 240 290" />
    <path className="s d" d="M420 70 Q418 170 420 290" />
    <path className="s" d="M20 168 Q300 164 590 170" />

    <text className="h" x="16" y="120">
      Granola
    </text>
    <path className="s" d="M128 114 Q170 110 212 114" />
    <text className="h" x="268" y="104">
      you type,
    </text>
    <text className="h" x="268" y="130">
      it listens
    </text>
    <path
      className="s"
      d="M466 80 L512 78 L522 90 L520 146 L466 148 Z M478 98 L506 98 M478 112 L508 112 M478 126 L500 126"
    />
    <text className="t" x="534" y="118">
      clean
    </text>
    <text className="t" x="534" y="134">
      notes
    </text>

    <text className="h pen" x="16" y="226">
      Savvy
    </text>
    <path
      className="s"
      d="M128 188 L166 186 L174 196 L172 236 L128 238 Z M138 202 L162 202 M138 214 L164 214 M138 226 L156 226"
    />
    <text className="t" x="114" y="262">
      brief from files
    </text>
    <path
      className="p"
      d="M262 192 Q330 186 400 192 Q406 214 400 236 Q330 242 262 236 Q256 214 262 192 Z"
    />
    <text className="h pen" x="276" y="222">
      say this, cite file
    </text>
    <text className="t" x="276" y="262">
      when they ask
    </text>
    <text className="t" x="440" y="222">
      not a team record
    </text>
  </Figure>
);

export const art: PostArt = { tone: "paper", cover, figure };
