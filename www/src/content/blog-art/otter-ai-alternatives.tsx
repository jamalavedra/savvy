import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import type { PostArt } from "./types";

// Three jobs in one bundle; pick the replacement by the job you actually use.
const ROWS = [
  { job: "Live captions", pick: "Keep Otter" },
  { job: "Team archive", pick: "Fireflies, Fathom" },
  { job: "Post-call summaries", pick: "Granola" },
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
        key={r.job}
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
        <div style={{ display: "flex" }}>{r.job}</div>
        <div style={{ display: "flex", color: "rgba(255,255,255,0.62)" }}>→ {r.pick}</div>
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
      <div style={{ display: "flex" }}>
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
          A fourth job
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 10,
        }}
      >
        <div style={{ display: "flex", fontSize: 22, color: C.fg }}>Help during the call</div>
        <div style={{ display: "flex", fontSize: 18, color: C.pinkDeep }}>→ Savvy</div>
      </div>
      <div style={{ display: "flex", marginTop: 6, fontSize: 15, color: C.muted }}>
        Guidance cards, not a transcript
      </div>
    </div>
  </div>
);

const figure = (
  <Figure
    caption="Neither is a vault. Otter keeps it all in one place; Savvy spreads it across three."
    label="Two diagrams. On the left, a call's audio, transcript and summary all flow into one box labelled the vendor. On the right, the audio flows to your transcription provider, excerpts and recent turns flow to your model provider, and the files stay on your Mac, deleted after 30 days."
  >
    <text className="h" textAnchor="middle" x="140" y="34">
      Otter
    </text>
    <text className="t" x="34" y="84">
      recording
    </text>
    <text className="t" x="34" y="134">
      transcript
    </text>
    <text className="t" x="34" y="184">
      summary
    </text>
    <path className="s" d="M100 80 Q150 92 182 120" markerEnd="url(#fig-arrow)" />
    <path className="s" d="M106 130 Q150 130 182 132" markerEnd="url(#fig-arrow)" />
    <path className="s" d="M96 180 Q150 172 182 146" markerEnd="url(#fig-arrow)" />
    <path
      className="s"
      d="M192 104 Q190 96 202 96 L262 97 Q272 98 271 110 L270 160 Q270 170 258 170 L202 169 Q192 169 192 158 Z"
    />
    <text className="h" textAnchor="middle" x="231" y="140">
      vendor
    </text>
    <text className="t" textAnchor="middle" x="231" y="196">
      under its terms
    </text>

    <path className="s d" d="M300 40 L300 270" />

    <text className="h pen" textAnchor="middle" x="450" y="34">
      Savvy
    </text>
    <circle className="s" cx="350" cy="140" r="9" />
    <path
      className="s"
      d="M350 149 L350 176 M350 156 L336 168 M350 156 L364 168 M350 176 L340 196 M350 176 L360 196"
    />
    <text className="t" textAnchor="middle" x="350" y="218">
      your call
    </text>
    <path className="p" d="M372 126 Q410 80 440 72" markerEnd="url(#fig-arrow)" />
    <path className="p" d="M374 142 Q410 142 440 142" markerEnd="url(#fig-arrow)" />
    <path className="p" d="M372 158 Q410 206 440 214" markerEnd="url(#fig-arrow)" />
    <text className="h" x="450" y="70">
      transcription key
    </text>
    <text className="t" x="450" y="90">
      receives the audio
    </text>
    <text className="h" x="450" y="140">
      model plan
    </text>
    <text className="t" x="450" y="160">
      sees excerpts + recent turns
    </text>
    <text className="h" x="450" y="212">
      your Mac
    </text>
    <text className="t" x="450" y="232">
      files, deleted after 30 days
    </text>
  </Figure>
);

export const art: PostArt = { tone: "moss", cover, figure };
