import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import { MONO, type PostArt } from "./types";

// A participant list: the bot is the row Savvy never adds.
const PEOPLE = ["You", "The client"];

const dot = (bg: string) => (
  <div style={{ display: "flex", width: 12, height: 12, borderRadius: 999, background: bg }} />
);

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
    <div
      style={{
        display: "flex",
        fontSize: 14,
        fontWeight: 700,
        color: "rgba(255,255,255,0.7)",
        paddingLeft: 4,
      }}
    >
      Participants
    </div>
    {PEOPLE.map((p) => (
      <div
        key={p}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 18px",
          borderRadius: 16,
          background: "rgba(255,255,255,0.14)",
          color: "rgba(255,255,255,0.88)",
          fontWeight: 700,
          fontSize: 17,
        }}
      >
        {dot("#9be3b0")}
        <div style={{ display: "flex" }}>{p}</div>
      </div>
    ))}
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 18px",
        borderRadius: 16,
        border: "2px dashed rgba(255,255,255,0.35)",
        color: "rgba(255,255,255,0.45)",
        fontWeight: 700,
        fontSize: 17,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {dot("rgba(255,255,255,0.3)")}
        <div style={{ display: "flex", textDecoration: "line-through" }}>Notetaker bot</div>
      </div>
      <div style={{ display: "flex", fontSize: 14 }}>not joining</div>
    </div>
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        marginTop: 6,
        padding: "16px 18px",
        borderRadius: 18,
        background: C.surface,
        boxShadow: "0 30px 60px -30px rgba(0,0,0,0.55)",
        fontWeight: 700,
      }}
    >
      <div style={{ display: "flex" }}>
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
          On your Mac
        </div>
      </div>
      <div style={{ display: "flex", marginTop: 10, fontSize: 22, color: C.fg }}>
        Your files stay where they are
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
        mic + system audio
      </div>
    </div>
  </div>
);

const figure = (
  <Figure
    caption="Neither side is 'no cloud'. The question is whether one vendor holds everything, or each provider sees only its slice."
    label="Two sketches side by side. Left, a bot: a call window with two people and a square bot head, an arrow down to one vendor box holding the recording, transcript and summary under their terms. Right, Savvy: a Mac box where your files stay, with a pink arrow carrying audio to a transcription provider and another carrying excerpts to a model provider."
  >
    <text className="h" x="30" y="36">
      a bot
    </text>
    <text className="h pen" x="330" y="36">
      Savvy
    </text>
    <path className="s d" d="M300 20 Q302 160 300 290" />

    <path
      className="s"
      d="M30 58 L170 56 Q176 58 176 64 L178 128 Q176 134 170 134 L36 136 Q30 134 30 128 Z"
    />
    <circle className="s" cx="62" cy="86" r="9" />
    <path className="s" d="M48 118 Q62 98 76 118" />
    <circle className="s" cx="102" cy="86" r="9" />
    <path className="s" d="M88 118 Q102 98 116 118" />
    <path className="r" d="M132 76 L152 76 L152 96 L132 96 Z M138 84 L140 84 M144 84 L146 84" />
    <path className="r" d="M128 118 Q142 102 156 118" />
    <text className="h red" x="186" y="96">
      joins!
    </text>

    <path className="s" d="M104 140 Q104 152 104 164" markerEnd="url(#fig-arrow)" />
    <path
      className="s"
      d="M36 176 L270 174 Q278 176 278 184 L280 252 Q278 260 270 260 L40 262 Q32 260 32 252 Z"
    />
    <text className="h" x="48" y="204">
      recording
    </text>
    <text className="h" x="48" y="228">
      transcript
    </text>
    <text className="h" x="48" y="252">
      summary
    </text>
    <text className="t" x="160" y="230">
      one vendor,
    </text>
    <text className="t" x="160" y="248">
      their terms
    </text>

    <path
      className="s"
      d="M326 150 L428 148 Q436 150 436 158 L438 240 Q436 248 428 248 L332 250 Q324 248 324 240 Z"
    />
    <text className="t" x="336" y="170">
      your Mac
    </text>
    <text className="h" x="336" y="204">
      your files
    </text>
    <text className="h" x="336" y="230">
      stay here
    </text>

    <path
      className="s"
      d="M432 128 Q416 126 420 108 Q426 90 446 96 Q452 72 482 76 Q506 68 520 88 Q546 82 552 104 Q574 110 566 128 Q560 140 540 138 L450 140 Q432 140 432 128 Z"
      transform="translate(127 -14) scale(0.8)"
      vectorEffect="non-scaling-stroke"
    />
    <text className="t" textAnchor="middle" x="524" y="80">
      transcription
    </text>
    <path
      className="s"
      d="M432 128 Q416 126 420 108 Q426 90 446 96 Q452 72 482 76 Q506 68 520 88 Q546 82 552 104 Q574 110 566 128 Q560 140 540 138 L450 140 Q432 140 432 128 Z"
      transform="translate(127 146) scale(0.8)"
      vectorEffect="non-scaling-stroke"
    />
    <text className="t" textAnchor="middle" x="524" y="240">
      model provider
    </text>

    <path className="p" d="M420 146 Q440 116 474 100" markerEnd="url(#fig-arrow)" />
    <text className="h pen" x="452" y="142">
      audio
    </text>
    <path className="p" d="M440 212 Q456 224 470 232" markerEnd="url(#fig-arrow)" />
    <text className="h pen" x="474" y="190">
      excerpts
    </text>
  </Figure>
);

export const art: PostArt = { tone: "night", cover, figure };
