import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import { MONO, type PostArt } from "./types";

// Seconds, not minutes: the facts move out of the long documents onto one page.
const FIELDS = [
  { k: "Objective", v: "one sentence" },
  { k: "Priorities", v: "ranked" },
  { k: "Concessions", v: "each with a condition" },
  { k: "Red lines", v: "few and real" },
];

const cover = (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      width: 440,
      height: 400,
      gap: 14,
      justifyContent: "center",
    }}
  >
    <div style={{ display: "flex", gap: 10 }}>
      {["40-page proposal", "folder of PDFs"].map((p) => (
        <div
          key={p}
          style={{
            display: "flex",
            padding: "8px 14px",
            borderRadius: 999,
            background: "rgba(255,255,255,0.14)",
            color: "rgba(255,255,255,0.78)",
            fontWeight: 700,
            fontSize: 15,
            textDecoration: "line-through",
          }}
        >
          {p}
        </div>
      ))}
    </div>
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "18px 20px",
        borderRadius: 18,
        background: C.surface,
        boxShadow: "0 30px 60px -30px rgba(0,0,0,0.55)",
        fontWeight: 700,
        gap: 10,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", fontSize: 22, color: C.fg }}>Negotiation brief</div>
        <div style={{ display: "flex", fontFamily: MONO, fontSize: 14, color: C.muted }}>
          1 page
        </div>
      </div>
      {FIELDS.map((f) => (
        <div
          key={f.k}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 12px",
            borderRadius: 10,
            background: C.inset,
            fontSize: 16,
          }}
        >
          <div style={{ display: "flex", color: f.k === "Red lines" ? C.danger : C.fg }}>{f.k}</div>
          <div style={{ display: "flex", color: C.muted, fontSize: 15 }}>{f.v}</div>
        </div>
      ))}
    </div>
  </div>
);

const figure = (
  <Figure
    caption="The concession is identical. Only the condition changes what you get back."
    label="Two versions of one concession, extend payment terms to 60 days. On the top, it is handed over alone and an arrow leads to a red label: given away for nothing. On the bottom, it is tied to a condition, if they commit to a two-year term, and an arrow leads to a pink label: a trade."
  >
    {/* top: bare concession */}
    <path
      className="s"
      d="M30 52 Q28 34 48 34 L244 35 Q262 36 261 54 L260 78 Q260 94 242 94 L48 93 Q30 93 30 76 Z"
    />
    <text className="h" x="46" y="72">
      payment terms → 60 days
    </text>
    <path className="r" d="M274 64 Q320 60 372 64" markerEnd="url(#fig-arrow)" />
    <text className="h red" x="384" y="70">
      given away for nothing
    </text>

    <path className="s d" d="M30 148 Q300 140 570 148" />

    {/* bottom: the same concession tied to its condition */}
    <path
      className="s"
      d="M30 202 Q28 184 48 184 L244 185 Q262 186 261 204 L260 228 Q260 244 242 244 L48 243 Q30 243 30 226 Z"
    />
    <text className="h" x="46" y="222">
      payment terms → 60 days
    </text>
    <path className="p" d="M261 214 Q274 202 287 214 Q300 226 312 214" />
    <path
      className="p"
      d="M312 202 Q312 190 326 190 L448 191 Q462 192 461 206 L460 224 Q460 238 446 238 L326 237 Q312 237 312 226 Z"
    />
    <text className="h pen" x="326" y="221">
      if 2-year term
    </text>
    <text className="t" x="326" y="262">
      no approval needed
    </text>
    <path className="p" d="M472 214 Q494 212 514 214" markerEnd="url(#fig-arrow)" />
    <text className="h pen" x="524" y="220">
      a trade
    </text>
  </Figure>
);

export const art: PostArt = { tone: "ember", cover, figure };
