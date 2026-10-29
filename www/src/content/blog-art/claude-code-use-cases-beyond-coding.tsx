import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import { MONO, type PostArt } from "./types";

// One signed-in CLI, many jobs with no source code in them.
const ROWS = [
  { job: "Ask across a folder", path: "deal/*.pdf" },
  { job: "Extract to JSON", path: "invoices/" },
  { job: "Rename and reconcile", path: "scans/" },
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
    <div
      style={{
        display: "flex",
        padding: "14px 18px",
        borderRadius: 16,
        background: "rgba(4,20,14,0.55)",
        fontFamily: MONO,
        fontSize: 17,
        color: "#fff",
        marginBottom: 6,
      }}
    >
      <div style={{ display: "flex", color: "rgba(255,255,255,0.55)", marginRight: 10 }}>$</div>
      <div style={{ display: "flex" }}>claude -p &quot;…&quot;</div>
    </div>
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
        <div
          style={{
            display: "flex",
            fontFamily: MONO,
            fontSize: 14,
            color: "rgba(255,255,255,0.6)",
          }}
        >
          {r.path}
        </div>
      </div>
    ))}
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "16px 18px",
        borderRadius: 18,
        background: C.surface,
        boxShadow: "0 30px 60px -30px rgba(0,0,0,0.55)",
        fontWeight: 800,
        fontSize: 19,
        color: C.fg,
      }}
    >
      <div style={{ display: "flex" }}>Power a meeting assistant</div>
      <div
        style={{
          display: "flex",
          fontSize: 14,
          fontWeight: 700,
          color: C.success,
          background: "#e7f2e9",
          padding: "3px 10px",
          borderRadius: 999,
        }}
      >
        Savvy
      </div>
    </div>
  </div>
);

const figure = (
  <Figure
    caption="Take the middle box out and the token invoice leaves with it. So does the key you had to guard."
    label="Two diagrams. Top, marked with a red cross: an app sends requests through the app maker's own server, which holds a vendor key and marks up tokens, before reaching the model. Bottom, in pink: the app spawns the CLI on the user's own machine, which talks to the model on the user's own plan."
  >
    {/* hosted: app -> your server (key, markup) -> model */}
    <text className="t" x="20" y="30">
      the usual way
    </text>
    <path className="s" d="M20 50 Q70 48 120 50 L120 96 Q70 98 20 96 Z" />
    <text className="h" x="44" y="80">
      app
    </text>
    <path className="s" d="M124 73 Q160 70 198 73" markerEnd="url(#fig-arrow)" />
    <path className="r" d="M210 40 Q300 36 390 40 L390 106 Q300 110 210 106 Z" />
    <text className="h red" x="226" y="68">
      your server
    </text>
    <text className="t" x="226" y="92">
      vendor key, token markup
    </text>
    <path className="s" d="M394 73 Q430 70 466 73" markerEnd="url(#fig-arrow)" />
    <path className="s" d="M478 50 Q530 48 580 50 L580 96 Q530 98 478 96 Z" />
    <text className="h" x="494" y="80">
      model
    </text>
    <path className="r" d="M392 22 L412 42 M412 22 L392 42" />

    {/* local: app spawns CLI, user's plan */}
    <text className="t" x="20" y="164">
      a CLI on the user&apos;s machine
    </text>
    <path
      className="s d"
      d="M14 176 Q200 172 400 176 Q404 232 400 284 Q200 288 14 284 Q10 232 14 176 Z"
    />
    <path className="s" d="M30 206 Q80 204 130 206 L130 252 Q80 254 30 252 Z" />
    <text className="h" x="54" y="236">
      app
    </text>
    <path className="p" d="M134 229 Q180 226 228 229" markerEnd="url(#fig-arrow)" />
    <text className="t" x="146" y="216">
      spawn
    </text>
    <path className="p" d="M240 206 Q310 204 380 206 L380 252 Q310 254 240 252 Z" />
    <text className="h pen" x="256" y="236">
      claude / codex
    </text>
    <path className="p" d="M384 229 Q430 226 466 229" markerEnd="url(#fig-arrow)" />
    <path className="s" d="M478 206 Q530 204 580 206 L580 252 Q530 254 478 252 Z" />
    <text className="h" x="494" y="236">
      model
    </text>
    <text className="h go" x="436" y="284">
      user&apos;s own plan
    </text>
  </Figure>
);

export const art: PostArt = { tone: "moss", cover, figure };
