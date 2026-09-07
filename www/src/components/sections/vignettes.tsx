import type { CSSProperties, ReactNode } from "react";
import { StatusLine } from "@/components/overlay/pieces";
import { RecommendationCard } from "@/components/overlay/RecommendationCard";

// Bento vignettes: icons and looping motion instead of prose. Each one is
// pure CSS (keyframes in globals.css "Vignette loops") so it runs without JS
// and pauses cleanly under prefers-reduced-motion. Product chrome comes from
// overlay.css (.sv, .tile-icon, .prepare-card, .scard, .swave).

const delay = (seconds: number) => ({ "--i-delay": `${seconds}s` }) as CSSProperties;

const stroke = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg {...stroke} width={size} height={size} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const D = {
  folder:
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  fileText:
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8",
  target:
    "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20ZM12 6a6 6 0 1 0 0 12 6 6 0 1 0 0-12ZM12 10a2 2 0 1 0 0 4 2 2 0 1 0 0-4Z",
  flag: "M4 22V4M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1",
  question: "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20ZM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01",
  check: "M20 6 9 17l-5-5",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  speaker: "M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
  play: "M8 5v14l11-7z",
  trash:
    "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  sparkles:
    "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0zM20 3v4M22 5h-4",
};

/** Grey text placeholder: a line of the document without the words. */
function Bar({ w, strong = false }: { w: string; strong?: boolean }) {
  return (
    <span
      className={`block h-2 rounded-full ${w} ${
        strong ? "bg-[color-mix(in_srgb,var(--text)_35%,transparent)]" : "bg-[var(--border)]"
      }`}
    />
  );
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
      {children}
    </span>
  );
}

// ── 01 · Point it at a folder ──────────────────────────────────────────────

const FILES: [string, string][] = [
  ["PDF", "#d85664"],
  ["DOCX", "#3b6fd4"],
  ["PPTX", "#cd8331"],
  ["XLSX", "#368c66"],
  ["MD", "#77736e"],
];

function FileBadge({ kind, color }: { kind: string; color: string }) {
  return (
    <span className="flex h-11 w-9 flex-col items-center justify-end rounded-md border border-[var(--border)] bg-[var(--surface)] pb-1 shadow-sm [clip-path:polygon(0_0,68%_0,100%_24%,100%_100%,0_100%)]">
      <span
        className="rounded-sm px-1 text-[7px] font-extrabold tracking-wide text-white"
        style={{ background: color }}
      >
        {kind}
      </span>
    </span>
  );
}

export function FolderVignette() {
  return (
    <div className="sv flex w-full max-w-[280px] flex-col items-center">
      <div className="flex h-12 items-end justify-center gap-2">
        {FILES.map(([kind, color], i) => (
          <span key={kind} className="file-drop" style={delay(i * 0.35)}>
            <FileBadge kind={kind} color={color} />
          </span>
        ))}
      </div>
      <div className="folder-bump relative mt-3 grid h-16 w-20 place-items-center rounded-2xl bg-[var(--tile)] text-[var(--accent)]">
        <Icon d={D.folder} size={34} />
        <span className="badge-pop absolute -right-2 -top-2 rounded-full bg-[var(--text)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--background)]">
          14
        </span>
      </div>
      <p className="mt-3 flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--success)]" />
        <Caption>Read-only</Caption>
      </p>
    </div>
  );
}

// ── 02 · A brief you approve ───────────────────────────────────────────────

const BRIEF_ROWS = [
  { icon: D.target, label: "Objective", tone: "text-[var(--accent)]", bars: ["w-32"] },
  {
    icon: D.flag,
    label: "Red lines",
    tone: "text-[var(--danger)]",
    bars: ["w-28", "w-20", "w-24"],
  },
  { icon: D.question, label: "Questions", tone: "text-[var(--muted)]", bars: ["w-24", "w-16"] },
];

export function BriefVignette() {
  return (
    <div className="sv w-full max-w-[260px]">
      <div className="prepare-card relative p-3.5 shadow-sm">
        <span className="check-pop absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-[var(--success)] px-2 py-0.5 text-[10px] font-bold text-white">
          <Icon d={D.check} size={11} />
          Approved
        </span>
        <div className="flex items-center gap-2.5">
          <span className="tile-icon">
            <Icon d={D.fileText} />
          </span>
          <span className="flex flex-col gap-1.5">
            <Bar w="w-24" strong />
            <Bar w="w-14" />
          </span>
        </div>
        <div className="mt-3 border-t border-[var(--border-soft)] pt-2">
          {BRIEF_ROWS.map((row, i) => (
            <div
              key={row.label}
              className="row-in flex items-start gap-2.5 py-2"
              style={delay(0.4 + i * 0.6)}
            >
              <span className={`mt-px ${row.tone}`}>
                <Icon d={row.icon} size={14} />
              </span>
              <div className="flex flex-1 flex-col gap-1.5">
                <Caption>{row.label}</Caption>
                {row.bars.map((w) => (
                  <Bar key={w} w={w} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 03 · Hears both sides ──────────────────────────────────────────────────

const WAVE = [0.35, 0.55, 0.8, 1, 0.7, 0.9, 0.6, 0.45, 0.3];

function Wave({ cls }: { cls: string }) {
  return (
    <span className={`swave flex-1 origin-center ${cls}`} aria-hidden="true">
      {WAVE.map((w, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed bar layout
          key={i}
          style={{ "--h": `${3 + w * 15}px`, "--d": `${(i % 4) * 0.13}s` } as CSSProperties}
        />
      ))}
    </span>
  );
}

function Channel({ icon, label, cls }: { icon: string; label: string; cls: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="tile-icon">
        <Icon d={icon} />
      </span>
      <span className="w-20 shrink-0">
        <Caption>{label}</Caption>
      </span>
      <Wave cls={cls} />
    </div>
  );
}

const LANGS = ["EN", "ES", "CA", "DE"];

export function ChannelsVignette() {
  return (
    <div className="sv w-full max-w-[290px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 shadow-sm">
      <Channel icon={D.speaker} label="System audio" cls="talk-a" />
      <Channel icon={D.mic} label="Microphone" cls="talk-b" />
      <div className="mt-2 flex items-center gap-1.5 border-t border-[var(--border-soft)] pt-3">
        {LANGS.map((lang, i) => (
          <span
            key={lang}
            className="pill-active rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
            style={delay(i * 1.5)}
          >
            {lang}
          </span>
        ))}
        <span className="ml-auto">
          <Caption>Auto detect</Caption>
        </span>
      </div>
    </div>
  );
}

// ── 04 · Say and avoid ─────────────────────────────────────────────────────

export function SayAvoidVignette() {
  return (
    <div className="sv sv-loop w-full max-w-[280px]">
      <RecommendationCard
        rec={{
          title: "Answer",
          say: "Net-60, if the annual stays.",
          avoid: "Don't quote net-90.",
          grounded: 94,
          source: "payment-terms.pdf · p.2",
        }}
        autoDismiss
        lifetime="6s"
        className="shadow-sm"
      />
    </div>
  );
}

// ── 05 · Advice on demand ──────────────────────────────────────────────────

export function AdviceVignette() {
  return (
    <div className="sv">
      <div className="scard shadow-sm">
        <div className="grid *:col-start-1 *:row-start-1">
          <div className="cycle-a">
            <StatusLine status="listening" advice />
          </div>
          <div className="cycle-b">
            <StatusLine status="manual" advice />
          </div>
        </div>
        <div className="sbase">
          <div className="sbase-l">
            <span className="sx spause" aria-hidden="true">
              <Icon d={D.mic} size={11} />
            </span>
          </div>
          <Wave cls="" />
          <div className="sbase-r">
            <kbd className="press rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
              ⌥⇧S
            </kbd>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 06 · Meetings stay on this Mac ─────────────────────────────────────────

function CountdownRing() {
  const r = 8;
  const circ = 2 * Math.PI * r;
  return (
    <span className="relative grid h-7 w-7 place-items-center" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="28" height="28" className="-rotate-90" aria-hidden="true">
        <circle cx="12" cy="12" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
        <circle
          className="ring-sweep"
          cx="12"
          cy="12"
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circ}
          style={{ "--circ": circ } as CSSProperties}
        />
      </svg>
      <span className="absolute font-mono text-[7px] font-bold text-[var(--muted)]">30d</span>
    </span>
  );
}

function HistoryRow({
  when,
  minutes,
  width,
  playing = false,
  expiring = false,
}: {
  when: string;
  minutes: string;
  width: string;
  playing?: boolean;
  expiring?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-3.5 py-3 ${expiring ? "row-expire" : ""}`}>
      <span className="sx" aria-hidden="true">
        <Icon d={expiring ? D.trash : D.play} size={11} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Bar w="w-20" strong />
          <span className="rounded-full bg-[var(--background-ui)] px-1.5 py-px font-mono text-[9px] text-[var(--muted)]">
            {when}
          </span>
        </div>
        <div className="mt-2 h-1 rounded-full bg-[var(--background-ui)]">
          <div
            className={`h-1 rounded-full bg-[var(--accent)] ${playing ? "playhead" : ""}`}
            style={{ width }}
          />
        </div>
      </div>
      {expiring ? (
        <CountdownRing />
      ) : (
        <span className="font-mono text-[10px] text-[var(--muted)]">{minutes}</span>
      )}
    </div>
  );
}

export function HistoryVignette() {
  return (
    <div className="sv w-full max-w-[280px]">
      <div className="prepare-card divide-y divide-[var(--border-soft)] shadow-sm">
        <HistoryRow when="Today" minutes="42 min" width="30%" playing />
        <HistoryRow when="Yesterday" minutes="27 min" width="0%" />
        <HistoryRow when="30 days ago" minutes="51 min" width="0%" expiring />
      </div>
    </div>
  );
}

export const SparkGlyph = <Icon d={D.sparkles} size={14} />;
