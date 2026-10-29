import { Figure } from "@/components/blog/Figure";
import { C } from "@/lib/og";
import { MONO, type PostArt } from "./types";

// The one-page brief: the post's six steps, in the order to write them.
const STEPS = [
  "Purpose in one sentence",
  "Who, and what they want",
  "Promises from last time",
  "Facts, each with its source",
  "Your questions",
  "What you must not say",
];

const tick = (
  <div
    style={{
      display: "flex",
      width: 6,
      height: 11,
      marginTop: -3,
      borderRight: "2.5px solid #ffffff",
      borderBottom: "2.5px solid #ffffff",
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
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div
        style={{
          display: "flex",
          padding: "6px 14px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.18)",
          color: "#ffffff",
          fontWeight: 700,
          fontSize: 15,
        }}
      >
        One page, glance during
      </div>
      <div
        style={{
          display: "flex",
          fontFamily: MONO,
          fontSize: 16,
          color: "rgba(255,255,255,0.9)",
        }}
      >
        15 + 5 min
      </div>
    </div>
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "16px 18px",
        gap: 9,
        borderRadius: 18,
        background: C.surface,
        boxShadow: "0 30px 60px -30px rgba(0,0,0,0.55)",
        fontWeight: 700,
      }}
    >
      {STEPS.map((s, i) => {
        const last = i === STEPS.length - 1;
        return (
          <div key={s} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                borderRadius: 999,
                background: last ? C.danger : C.success,
              }}
            >
              {tick}
            </div>
            <div style={{ display: "flex", fontSize: 18, color: last ? C.danger : C.fg }}>{s}</div>
          </div>
        );
      })}
    </div>
  </div>
);

const figure = (
  <Figure
    caption="A tool can look up who is coming. Only your own folder knows what you are not allowed to promise."
    label="A hand-drawn one-page checklist numbered one to six. On the left, an AI prep tool fed by calendar, attendees and emails sends green arrows to step 2, people, and step 3, last time, and a dashed red arrow with a question mark towards step 4. On the right, a folder labelled your folder sends pink arrows to step 4, facts with source, and step 6, must not say."
  >
    <path
      className="s"
      d="M212 22 L392 20 Q398 22 398 28 L400 280 Q398 286 392 286 L216 288 Q210 286 210 280 Z"
    />
    <text className="h" x="226" y="58">
      1 purpose
    </text>
    <text className="h" x="226" y="100">
      2 people
    </text>
    <text className="h" x="226" y="142">
      3 last time
    </text>
    <text className="h pen" x="226" y="184">
      4 facts + source
    </text>
    <text className="h" x="226" y="226">
      5 questions
    </text>
    <text className="h pen" x="226" y="268">
      6 must not say
    </text>

    <path
      className="s"
      d="M28 70 L118 68 Q124 70 124 76 L126 118 Q124 124 118 124 L32 126 Q26 124 26 118 Z"
    />
    <text className="h" x="40" y="104">
      AI prep
    </text>
    <text className="t" x="24" y="148">
      calendar, attendees,
    </text>
    <text className="t" x="24" y="166">
      past emails
    </text>
    <path className="g" d="M130 86 Q170 82 208 94" markerEnd="url(#fig-arrow)" />
    <path className="g" d="M130 108 Q172 120 208 134" markerEnd="url(#fig-arrow)" />
    <path className="r d" d="M110 180 Q150 196 186 184" markerEnd="url(#fig-arrow)" />
    <text className="h red" x="150" y="226">
      ?
    </text>

    <path
      className="s"
      d="M470 164 L500 162 L510 174 L576 172 Q582 174 582 180 L584 232 Q582 238 576 238 L476 240 Q470 238 470 232 Z"
    />
    <text className="h pen" x="466" y="268">
      your folder
    </text>
    <path className="p" d="M466 186 Q440 180 404 178" markerEnd="url(#fig-arrow)" />
    <path className="p" d="M466 226 Q440 254 404 262" markerEnd="url(#fig-arrow)" />
  </Figure>
);

export const art: PostArt = { tone: "ember", cover, figure };
