import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import { MONO, type PostArt } from "./types";

// No bot gives notice, so the notice is a sentence you say in the first minute.
const PILLS = ["No bot in the call", "No hidden mode", "Visible panel"];

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
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      {PILLS.map((p) => (
        <div
          key={p}
          style={{
            display: "flex",
            padding: "8px 14px",
            borderRadius: 999,
            background: "rgba(255,255,255,0.14)",
            color: "rgba(255,255,255,0.85)",
            fontWeight: 700,
            fontSize: 15,
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
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", fontSize: 14, color: C.muted }}>
          First minute of the call
        </div>
        <div style={{ display: "flex", fontFamily: MONO, fontSize: 14, color: C.muted }}>00:00</div>
      </div>
      <div style={{ display: "flex", marginTop: 12, fontSize: 22, lineHeight: 1.3, color: C.fg }}>
        “I use a notes assistant. Is that all right with you?”
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            borderRadius: 999,
            background: C.success,
            color: "#fff",
            fontSize: 15,
          }}
        >
          ✓
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
          Said out loud, not buried
        </div>
      </div>
    </div>
  </div>
);

const figure = (
  <Figure
    caption="Take the bot out of the call and the notice leaves with it. One sentence puts it back."
    label="Two calls side by side. On the left, a participant list shows a bot tile, and an arrow labels it: the bot is the notice. On the right, the bot tile is empty, and your own tile has a speech bubble saying: notes assistant, OK? An arrow labels it: you are the notice."
  >
    {/* left: bot call */}
    <path
      className="s"
      d="M30 60 Q28 40 50 40 L250 42 Q270 42 270 62 L268 180 Q268 200 248 200 L50 198 Q30 198 30 178 Z"
    />
    <text className="t" x="46" y="64">
      participants
    </text>
    <path
      className="s"
      d="M50 80 Q50 76 56 76 L120 77 Q126 77 126 83 L125 130 Q125 136 119 136 L56 135 Q50 135 50 129 Z"
    />
    <circle className="s" cx="88" cy="98" r="8" />
    <path className="s" d="M74 124 Q88 108 102 124" />
    <path
      className="s"
      d="M150 77 Q150 76 156 76 L236 77 Q242 77 242 83 L241 130 Q241 136 235 136 L156 135 Q150 135 150 129 Z"
    />
    <path
      className="s"
      d="M182 90 L210 90 L210 110 L182 110 Z M191 99 L191 101 M201 99 L201 101 M196 90 L196 83"
    />
    <text className="t" textAnchor="middle" x="196" y="128">
      notes bot
    </text>
    <path className="s" d="M196 238 Q200 190 196 146" markerEnd="url(#fig-arrow)" />
    <text className="h" textAnchor="middle" x="150" y="268">
      the bot is the notice
    </text>

    {/* right: bot-free, the person in the tile says it */}
    <path
      className="s"
      d="M330 60 Q328 40 350 40 L564 42 Q586 42 586 62 L584 180 Q584 200 562 200 L350 198 Q330 198 330 178 Z"
    />
    <text className="t" x="346" y="64">
      participants
    </text>
    <path
      className="s"
      d="M350 80 Q350 76 356 76 L420 77 Q426 77 426 83 L425 130 Q425 136 419 136 L356 135 Q350 135 350 129 Z"
    />
    <circle className="s" cx="388" cy="98" r="8" />
    <path className="s" d="M374 124 Q388 108 402 124" />
    <path className="s d" d="M450 77 L540 77 L540 136 L450 136 Z" />
    <text className="t" textAnchor="middle" x="495" y="112">
      no bot
    </text>
    <path
      className="p"
      d="M404 150 Q404 144 416 144 L564 144 Q574 145 573 158 L572 178 Q572 188 560 188 L416 188 Q406 188 406 178 L406 160 L396 140 Z"
    />
    <text className="h pen" x="416" y="173">
      notes assistant, ok?
    </text>
    <path className="p" d="M470 238 Q474 214 480 194" markerEnd="url(#fig-arrow)" />
    <text className="h pen" textAnchor="middle" x="450" y="268">
      you are the notice
    </text>
  </Figure>
);

export const art: PostArt = { tone: "night", cover, figure };
