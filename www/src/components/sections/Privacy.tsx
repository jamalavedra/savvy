import type { CSSProperties } from "react";
import { FadeInUp } from "@/components/animations/FadeInUp";
import {
  ClockIcon,
  Eyebrow,
  FolderIcon,
  KeyIcon,
  StatList,
  TwoLineHeading,
  WaveIcon,
} from "@/components/sections/primitives";
import "./privacy.css";

// The README's data table as a picture: an enclosure holding what never
// leaves, and two lanes out of it — audio streaming continuously to the
// transcription provider, excerpts going in bursts only at recommendation
// time. Motion lives in privacy.css.

const D = {
  laptop: "M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10H4ZM2 19h20",
  doc: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5M9 13h6M9 17h6",
  db: "M12 3c-4 0-7 1.1-7 2.5S8 8 12 8s7-1.1 7-2.5S16 3 12 3ZM5 5.5v13C5 19.9 8 21 12 21s7-1.1 7-2.5v-13M5 12c0 1.4 3 2.5 7 2.5s7-1.1 7-2.5",
  clipboard: "M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M9 3h6v3H9Z",
  key: "M14.5 8.5 20 3M21.5 4.5 20 6M6.5 20a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM9.4 14.1 13 10.5",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM18.5 11v1a6.5 6.5 0 0 1-13 0v-1M12 18.5V21",
  spark: "M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9ZM18 16v3M19.5 17.5h-3",
  wave: "M2.5 12h2M8 7.5v9M12 4v16M16 7.5v9M19.5 12h2",
  chevron: "m7 10 5 5 5-5",
};

const vars = (v: Record<string, string>) => v as CSSProperties;

function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const STAYS = [
  { icon: D.doc, name: "Documents", sub: "Unchanged" },
  { icon: D.db, name: "Indexes", sub: "Local SQLite" },
  { icon: D.clipboard, name: "Brief", sub: "Private, versioned" },
  { icon: D.key, name: "Provider keys", sub: "Keychain" },
];

function Chip({
  icon,
  name,
  sub,
  className = "",
}: {
  icon: string;
  name: string;
  sub: string;
  className?: string;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-2.5 rounded-lg border border-border-soft bg-background px-2.5 py-2 ${className}`}
    >
      <span className="shrink-0 text-muted">
        <Icon d={icon} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-medium leading-tight">{name}</span>
        <span className="block truncate font-mono text-[10px] leading-tight text-muted">{sub}</span>
      </span>
    </div>
  );
}

// Three packets per lane. `--pv-d` staggers them in flight; `--pv-park`
// is where each one sits when motion is off.
const PACKETS = [
  { d: "0s", burst: "0s", park: "2px" },
  { d: "0.53s", burst: "0.28s", park: "20px" },
  { d: "1.06s", burst: "0.56s", park: "38px" },
];

const LANES = [
  {
    key: "audio",
    icon: D.mic,
    title: "Meeting audio",
    dest: "Your transcription provider",
    note: "Continuous",
    line: "pv-line",
    dot: "bg-danger",
    burst: false,
    card: "border-danger/40",
    tone: "text-danger",
  },
  {
    key: "excerpts",
    icon: D.spark,
    title: "Excerpts, brief, recent turns",
    dest: "Your model provider",
    note: "During guidance",
    line: "pv-line-dashed",
    dot: "bg-muted",
    burst: true,
    card: "border-border",
    tone: "text-foreground",
  },
];

function Diagram() {
  return (
    <div className="bg-background-alt p-5 sm:p-8">
      <div className="relative">
        <div
          aria-hidden="true"
          className="pv-ring pointer-events-none absolute -inset-1 rounded-[18px] border border-accent/40"
        />
        <div className="relative rounded-2xl border border-border bg-surface p-3.5 sm:p-4">
          <div className="flex items-center gap-2 pb-3">
            <span className="text-muted">
              <Icon d={D.laptop} size={16} />
            </span>
            <span className="text-[13px] font-medium">Your Mac</span>
            <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-muted">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
              Stays here
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {STAYS.map((item) => (
              <Chip key={item.name} icon={item.icon} name={item.name} sub={item.sub} />
            ))}
            <Chip
              className="col-span-2"
              icon={D.wave}
              name="Recordings + transcripts"
              sub="Deleted after 30 days"
            />
          </div>
        </div>
      </div>

      <p className="pt-4 text-center font-mono text-[9px] uppercase tracking-wider text-muted">
        Leaves your Mac
      </p>

      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        {LANES.map((lane) => (
          <div key={lane.key} className="flex flex-col items-center">
            <div className="relative h-12 w-6" style={vars({ "--pv-len": "42px" })}>
              <span aria-hidden="true" className={lane.line} />
              {PACKETS.map((p) => (
                <span
                  key={p.park}
                  aria-hidden="true"
                  className={`pv-packet ${lane.dot} ${lane.burst ? "pv-burst" : ""}`}
                  style={vars({
                    "--pv-d": lane.burst ? p.burst : p.d,
                    "--pv-park": p.park,
                  })}
                />
              ))}
            </div>
            <span className={`-mt-1.5 ${lane.tone}`}>
              <Icon d={D.chevron} size={16} />
            </span>
            <div
              className={`mt-1 flex w-full flex-1 flex-col rounded-xl border bg-surface p-3 ${lane.card}`}
            >
              <div className={`flex items-center gap-2 ${lane.tone}`}>
                <Icon d={lane.icon} />
                <span className="text-[12px] font-semibold leading-tight">{lane.title}</span>
              </div>
              <p className="mt-1.5 mb-2.5 text-[11px] leading-snug text-muted">{lane.dest}</p>
              <div className="mt-auto flex items-center gap-2 border-t border-border-soft pt-2">
                {lane.burst ? null : (
                  <span aria-hidden="true" className="flex h-3 items-center gap-[3px]">
                    {PACKETS.map((p, i) => (
                      <span
                        key={p.park}
                        className="pv-bar h-3 w-[3px] rounded-full bg-danger"
                        style={vars({ "--pv-d": `${i * 0.18}s` })}
                      />
                    ))}
                  </span>
                )}
                <span
                  className={`font-mono text-[9px] uppercase tracking-wider ${
                    lane.burst ? "text-muted" : "text-danger"
                  }`}
                >
                  {lane.note}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Privacy() {
  return (
    <section id="privacy" className="py-20 lg:py-28">
      <div className="page-column grid items-center gap-12 lg:grid-cols-2">
        <FadeInUp>
          <Eyebrow>Local-first</Eyebrow>
          <TwoLineHeading
            className="mt-4"
            line1="Know where your data goes"
            line2="Local storage, external AI providers"
          />
          <p className="mt-6 max-w-md text-sm leading-relaxed text-muted">
            Source files stay in their folders. Savvy stores extracted text and indexes in a local
            database. Audio streams to your transcription provider. AI tasks send selected excerpts,
            your brief and recent transcript turns to your model provider. At startup, Savvy removes
            local recordings and transcripts older than 30 days.
          </p>
          <StatList
            items={[
              { icon: FolderIcon, label: "Source files remain unchanged" },
              { icon: KeyIcon, label: "Provider keys in the macOS Keychain" },
              { icon: ClockIcon, label: "30-day local retention, cleaned up at startup" },
              { icon: WaveIcon, label: "Audio streams only to your transcription provider" },
            ]}
          />
        </FadeInUp>

        <FadeInUp delay={0.1}>
          <Diagram />
        </FadeInUp>
      </div>
    </section>
  );
}
