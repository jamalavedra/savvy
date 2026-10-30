import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import type { PostArt } from "./types";

// The post's two questions as a 2x2: bot or not, after or during.
const head = {
  display: "flex",
  flex: 1,
  justifyContent: "center",
  fontSize: 15,
  fontWeight: 800,
  color: "rgba(40,24,10,0.7)",
} as const;
const rowLabel = {
  display: "flex",
  width: 92,
  alignItems: "center",
} as const;
const rowPill = {
  display: "flex",
  padding: "5px 10px",
  borderRadius: 999,
  background: "rgba(255,255,255,0.55)",
  fontSize: 15,
  fontWeight: 800,
  color: C.fg,
} as const;
const cell = {
  display: "flex",
  flex: 1,
  height: 120,
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
  borderRadius: 16,
  background: "rgba(255,255,255,0.55)",
  color: C.fg,
  fontWeight: 700,
  fontSize: 16,
  gap: 4,
} as const;

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
    <div style={{ display: "flex", gap: 12 }}>
      <div style={{ display: "flex", width: 92 }} />
      <div style={head}>After the call</div>
      <div style={head}>During it</div>
    </div>
    <div style={{ display: "flex", gap: 12 }}>
      <div style={rowLabel}>
        <div style={rowPill}>Bot joins</div>
      </div>
      <div style={cell}>
        <div style={{ display: "flex" }}>Otter</div>
        <div style={{ display: "flex" }}>Fireflies</div>
        <div style={{ display: "flex" }}>Fathom</div>
      </div>
      <div style={{ ...cell, background: "rgba(255,255,255,0.25)", color: C.muted }}>
        <div style={{ display: "flex" }}>Otter</div>
        <div style={{ display: "flex", fontSize: 14 }}>live transcript</div>
      </div>
    </div>
    <div style={{ display: "flex", gap: 12 }}>
      <div style={rowLabel}>
        <div style={rowPill}>No bot</div>
      </div>
      <div style={cell}>
        <div style={{ display: "flex" }}>Granola</div>
      </div>
      <div
        style={{
          ...cell,
          background: C.surface,
          boxShadow: "0 30px 60px -30px rgba(0,0,0,0.55)",
          fontSize: 20,
          fontWeight: 800,
        }}
      >
        <div
          style={{
            display: "flex",
            width: 30,
            height: 30,
            borderRadius: 999,
            background: C.success,
            color: "#fff",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              width: 8,
              height: 14,
              marginTop: -3,
              borderRight: "3px solid #fff",
              borderBottom: "3px solid #fff",
              transform: "rotate(45deg)",
            }}
          />
        </div>
        <div style={{ display: "flex" }}>Savvy</div>
        <div style={{ display: "flex", fontSize: 14, color: C.muted, fontWeight: 700 }}>
          cites your files
        </div>
      </div>
    </div>
  </div>
);

const figure = (
  <Figure
    caption="The audio is the same. What differs is who else turns up to hear it."
    label="Left: a video call with two participants and a third tile labelled notetaker bot, with an arrow carrying the call up to the vendor's cloud. Right: a person at a laptop with sound waves going into the laptop and a note saying nothing joins; the same laptop also catches a room and a phone call."
  >
    {/* left: bot in the call */}
    <text className="h" x="40" y="34">
      bot-based
    </text>
    <path
      className="s"
      d="M30 60 Q150 56 270 60 Q274 150 270 230 Q150 234 30 230 Q26 150 30 60 Z"
    />
    <path className="s" d="M40 70 Q90 68 140 70 L140 140 Q90 142 40 140 Z" />
    <circle className="s" cx="90" cy="96" r="10" />
    <path className="s" d="M72 132 Q90 110 108 132" />
    <path className="s" d="M160 70 Q210 68 260 70 L260 140 Q210 142 160 140 Z" />
    <circle className="s" cx="210" cy="96" r="10" />
    <path className="s" d="M192 132 Q210 110 228 132" />
    <path className="r" d="M100 152 Q150 150 200 152 L200 218 Q150 220 100 218 Z" />
    <path
      className="r"
      d="M128 172 L172 172 L172 198 L128 198 Z M142 182 L142 184 M158 182 L158 184"
    />
    <path className="r" d="M150 172 L150 162" />
    <text className="t" textAnchor="middle" x="150" y="252">
      a third tile everyone can see
    </text>
    <path className="s d" d="M262 100 Q300 60 290 26" markerEnd="url(#fig-arrow)" />
    <text className="h red" x="200" y="18">
      vendor cloud
    </text>

    {/* right: bot-free */}
    <text className="h" x="340" y="34">
      bot-free
    </text>
    <circle className="s" cx="380" cy="120" r="10" />
    <path
      className="s"
      d="M380 130 L380 168 M380 140 L404 156 M380 168 L366 196 M380 168 L394 196"
    />
    <path className="p" d="M420 132 Q470 130 520 132 L516 190 Q470 192 424 190 Z" />
    <path className="p" d="M404 200 Q470 196 540 200" />
    <path className="p d" d="M540 110 Q550 125 540 140 M556 100 Q572 125 556 150" />
    <text className="h pen" x="430" y="168">
      your Mac
    </text>
    <text className="h go" x="400" y="236">
      nothing joins
    </text>
    <text className="t" x="400" y="262">
      also hears a room or a phone
    </text>
  </Figure>
);

export const art: PostArt = { tone: "paper", cover, figure };
