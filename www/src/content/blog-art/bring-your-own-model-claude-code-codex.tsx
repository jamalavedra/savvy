import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import { MONO, type PostArt } from "./types";

// Savvy -> your CLI -> your plan, then what one request carries.
const pill = {
  display: "flex",
  padding: "10px 14px",
  borderRadius: 999,
  background: "rgba(255,255,255,0.16)",
  color: "#fff",
  fontWeight: 800,
  fontSize: 16,
} as const;
const link = {
  display: "flex",
  width: 18,
  height: 2,
  background: "rgba(255,255,255,0.6)",
} as const;

const tick = (ok: boolean) => (
  <div
    style={{
      display: "flex",
      width: 20,
      height: 20,
      borderRadius: 999,
      background: ok ? "#e7f2e9" : "#fbe7df",
      justifyContent: "center",
      alignItems: "center",
    }}
  >
    {ok ? (
      <div
        style={{
          display: "flex",
          width: 6,
          height: 10,
          marginTop: -2,
          borderRight: `2px solid ${C.success}`,
          borderBottom: `2px solid ${C.success}`,
          transform: "rotate(45deg)",
        }}
      />
    ) : (
      <div
        style={{ display: "flex", width: 8, height: 2, borderRadius: 2, background: C.danger }}
      />
    )}
  </div>
);

const ROWS = [
  { ok: true, text: "Brief and red lines" },
  { ok: true, text: "Up to six excerpts" },
  { ok: true, text: "Recent transcript turns" },
  { ok: false, text: "Full documents" },
  { ok: false, text: "Audio or your keys" },
];

const cover = (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      width: 440,
      height: 400,
      gap: 18,
      justifyContent: "center",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
      <div style={pill}>Savvy</div>
      <div style={link} />
      <div style={{ ...pill, fontFamily: MONO, fontWeight: 500 }}>claude · codex</div>
      <div style={link} />
      <div style={{ ...pill, background: C.surface, color: C.fg }}>Your plan</div>
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
      <div style={{ display: "flex", fontSize: 14, color: C.muted }}>One request carries</div>
      {ROWS.map((r) => (
        <div
          key={r.text}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 18,
            color: r.ok ? C.fg : C.muted,
            textDecoration: r.ok ? "none" : "line-through",
          }}
        >
          {tick(r.ok)}
          <div style={{ display: "flex" }}>{r.text}</div>
        </div>
      ))}
    </div>
  </div>
);

const figure = (
  <Figure
    caption="Clippings travel, the folder stays home. Even the clippings go under your account, not ours."
    label="A laptop holds a folder of source documents, an audio wave and a key. Scissors cut a few excerpts from the folder; those excerpts, the brief and recent transcript turns go in an envelope along an arrow to your CLI's model provider. Crossed-out arrows show the full documents, the audio and the key staying on the laptop."
  >
    {/* the Mac */}
    <path
      className="s"
      d="M30 70 Q150 66 270 70 Q274 160 270 240 Q150 244 30 240 Q26 160 30 70 Z"
    />
    <path className="s" d="M14 254 Q150 250 286 254" />
    <text className="h" x="40" y="58">
      your Mac
    </text>

    {/* folder */}
    <path className="s" d="M50 110 L80 110 L88 100 L120 100 L120 110 L150 110 L150 180 L50 180 Z" />
    <path className="s" d="M62 128 L138 128 M62 142 L138 142 M62 156 L120 156" />
    <text className="t" x="56" y="200">
      full documents
    </text>

    {/* audio + key */}
    <path
      className="s"
      d="M178 120 Q186 100 194 120 Q202 140 210 120 Q218 100 226 120 Q234 140 242 120"
    />
    <text className="t" x="186" y="148">
      audio
    </text>
    <circle className="s" cx="190" cy="186" r="9" />
    <path className="s" d="M199 186 L240 186 M228 186 L228 196 M238 186 L238 194" />
    <text className="t" x="186" y="216">
      your keys
    </text>

    {/* clippings cut from the folder */}
    <path className="p d" d="M152 124 Q220 70 292 96" markerEnd="url(#fig-arrow)" />
    <path className="p" d="M300 92 L340 92 L340 112 L300 112 Z M308 100 L332 100" />
    <path className="p" d="M306 120 L346 120 L346 140 L306 140 Z M314 128 L338 128" />
    <path className="p" d="M300 148 L340 148 L340 168 L300 168 Z M308 156 L332 156" />
    <text className="h pen" x="292" y="196">
      up to six excerpts
    </text>
    <text className="t" x="294" y="216">
      + the brief + recent turns
    </text>

    {/* envelope going out */}
    <path className="p" d="M356 132 Q410 120 456 128" markerEnd="url(#fig-arrow)" />
    <path className="s" d="M470 100 Q530 98 586 100 L584 156 Q530 158 472 156 Z" />
    <path className="s" d="M472 102 L528 132 L584 102" />
    <text className="h" x="466" y="186">
      your CLI&apos;s
    </text>
    <text className="h" x="466" y="210">
      provider
    </text>

    {/* what never leaves */}
    <path className="r d" d="M100 214 Q110 262 180 276" />
    <path className="r" d="M196 268 L212 284 M212 268 L196 284" />
    <text className="h red" x="226" y="284">
      never sent
    </text>
  </Figure>
);

export const art: PostArt = { tone: "ember", cover, figure };
