import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import { MONO, type PostArt } from "./types";

// The setup choice: two providers, one key. Prices are the post's 2026 figures.
const OPTIONS = [
  { name: "Deepgram", model: "nova-3", price: "~$0.46/hr", picked: true },
  { name: "AssemblyAI", model: "universal-streaming", price: "$0.15/hr", picked: false },
];

const check = (
  <div
    style={{
      display: "flex",
      width: 7,
      height: 12,
      marginTop: -3,
      borderRight: "3px solid #ffffff",
      borderBottom: "3px solid #ffffff",
      transform: "rotate(45deg)",
    }}
  />
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
        flexDirection: "column",
        padding: "16px 18px",
        gap: 10,
        borderRadius: 18,
        background: C.surface,
        boxShadow: "0 30px 60px -30px rgba(0,0,0,0.55)",
        fontWeight: 700,
      }}
    >
      <div style={{ display: "flex", fontSize: 14, color: C.muted }}>Transcription key</div>
      {OPTIONS.map((o) => (
        <div
          key={o.name}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "10px 12px",
            borderRadius: 12,
            background: o.picked ? "#e7f2e9" : C.inset,
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
              background: o.picked ? C.success : C.surface,
              border: o.picked ? "none" : `2px solid ${C.border}`,
            }}
          >
            {o.picked ? check : null}
          </div>
          <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
            <div style={{ display: "flex", fontSize: 20, color: C.fg }}>{o.name}</div>
            <div style={{ display: "flex", fontFamily: MONO, fontSize: 14, color: C.muted }}>
              {o.model}
            </div>
          </div>
          <div style={{ display: "flex", fontFamily: MONO, fontSize: 15, color: C.fg }}>
            {o.price}
          </div>
        </div>
      ))}
    </div>
    <div
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
      <div style={{ display: "flex" }}>5 hours of calls</div>
      <div style={{ display: "flex", fontFamily: MONO, fontSize: 16 }}>$0.75 to $2.30</div>
    </div>
    <div
      style={{
        display: "flex",
        alignSelf: "flex-start",
        padding: "6px 14px",
        borderRadius: 999,
        border: "1.5px solid rgba(255,255,255,0.5)",
        color: "rgba(255,255,255,0.8)",
        fontWeight: 700,
        fontSize: 15,
      }}
    >
      Switch later in Settings
    </div>
  </div>
);

const figure = (
  <Figure
    caption="Choosing a provider chooses who hears the audio. Your files never make that trip."
    label="A sketch of a Mac holding your files, the index, and transcripts kept for 30 days, with a microphone at its edge. One pink arrow labelled audio leaves the Mac for a cloud labelled your provider, noted as your key, your account. Nothing else crosses the line."
  >
    <path
      className="s"
      d="M30 72 Q28 60 42 60 L298 58 Q312 60 310 74 L312 236 Q310 250 296 250 L44 252 Q30 250 30 236 Z"
    />
    <text className="t" x="46" y="84">
      your Mac
    </text>
    <text className="h" x="50" y="122">
      your files (read-only)
    </text>
    <text className="h" x="50" y="160">
      the SQLite index
    </text>
    <text className="h" x="50" y="198">
      transcripts, 30 days
    </text>
    <text className="t" x="46" y="234">
      stays here
    </text>

    <path
      className="s"
      d="M272 112 Q272 98 282 98 Q292 98 292 112 L292 130 Q292 142 282 142 Q272 142 272 130 Z"
    />
    <path className="s" d="M266 130 Q268 152 282 152 Q296 152 298 130 M282 152 L282 164" />

    <path className="p" d="M300 120 Q360 80 420 104" markerEnd="url(#fig-arrow)" />
    <text className="h pen" x="330" y="78">
      audio
    </text>

    <path
      className="s"
      d="M432 128 Q416 126 420 108 Q426 90 446 96 Q452 72 482 76 Q506 68 520 88 Q546 82 552 104 Q574 110 566 128 Q560 140 540 138 L450 140 Q432 140 432 128 Z"
    />
    <text className="t" textAnchor="middle" x="494" y="120">
      your provider
    </text>
    <text className="h" x="400" y="176">
      your key,
    </text>
    <text className="h" x="400" y="202">
      your account
    </text>
    <text className="t" x="400" y="232">
      no offline mode yet
    </text>
  </Figure>
);

export const art: PostArt = { tone: "moss", cover, figure };
