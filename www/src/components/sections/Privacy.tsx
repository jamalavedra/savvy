import type { CSSProperties } from "react";
import { FadeInUp } from "@/components/animations/FadeInUp";
import {
  ClockIcon,
  FolderIcon,
  KeyIcon,
  MascotNote,
  SparkIcon,
  StatList,
  TerminalIcon,
  TwoLineHeading,
  WaveIcon,
} from "@/components/sections/primitives";
import "./privacy.css";

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
      strokeWidth="1.5"
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
      className={`flex min-w-0 items-center gap-2.5 rounded-xl bg-white px-2.5 py-2 ring-1 ring-black/[0.06] ${className}`}
    >
      <span className="shrink-0 text-muted">
        <Icon d={icon} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold leading-tight">{name}</span>
        <span className="mt-0.5 block truncate text-[12px] leading-tight text-muted">{sub}</span>
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
    card: "border-danger/25",
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
    card: "border-black/[0.08]",
    tone: "text-foreground",
  },
];

function Diagram() {
  return (
    <div className="art-panel art-night p-5 sm:p-8">
      <div className="art-card p-4 sm:p-5">
        <div>
          <div className="rounded-2xl bg-card-inset p-3 sm:p-3.5">
            <div className="flex items-center gap-2 pb-3">
              <span className="text-muted">
                <Icon d={D.laptop} size={16} />
              </span>
              <span className="text-[14px] font-semibold">Your Mac</span>
              <span className="ml-auto rounded-md bg-success/10 px-1.5 py-0.5 text-[12px] font-medium text-success">
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

        <p className="pt-4 text-center text-[12px] font-medium text-muted">Leaves your Mac</p>

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
                className={`mt-1 flex w-full flex-1 flex-col rounded-2xl border p-3 ${lane.card}`}
              >
                <div className={`flex items-center gap-2 ${lane.tone}`}>
                  <Icon d={lane.icon} />
                  <span className="text-[13px] font-semibold leading-tight">{lane.title}</span>
                </div>
                <p className="mt-1.5 mb-2.5 text-[12px] leading-snug text-muted">{lane.dest}</p>
                <span
                  className={`mt-auto self-start rounded-md px-1.5 py-0.5 text-[12px] font-medium ${
                    lane.burst ? "bg-black/5 text-muted" : "bg-danger/10 text-danger"
                  }`}
                >
                  {lane.note}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Privacy() {
  return (
    <section id="privacy" className="py-20 lg:py-28">
      <div className="page-column grid items-center gap-12 lg:grid-cols-2">
        <FadeInUp>
          <TwoLineHeading
            line1="Your accounts, your data"
            line2="Choose your providers, see where data goes"
          />
          <StatList
            items={[
              {
                icon: TerminalIcon,
                label: (
                  <span>
                    <strong className="font-semibold">Your own:</strong> Claude Code or Codex CLI,
                    on your account
                  </span>
                ),
              },
              {
                icon: KeyIcon,
                label: (
                  <span>
                    <strong className="font-semibold">Your own:</strong> Deepgram or AssemblyAI key,
                    kept in the macOS Keychain
                  </span>
                ),
              },
              {
                icon: SparkIcon,
                label: (
                  <span>
                    <strong className="font-semibold">Managed:</strong> a top-performing model on EU
                    servers, no keys to set up
                  </span>
                ),
              },
              { icon: KeyIcon, label: "Composio stores connected-app credentials" },
              { icon: FolderIcon, label: "Source files stay on your Mac; imported copies can refresh" },
              { icon: ClockIcon, label: "Recordings and transcripts deleted after 30 days" },
              {
                icon: WaveIcon,
                label: "Audio streams to transcription, through Savvy in managed mode",
              },
            ]}
          />
          <MascotNote className="mt-8" state="muted" note="Your keys, your providers." />
        </FadeInUp>

        <FadeInUp delay={0.1}>
          <Diagram />
        </FadeInUp>
      </div>
    </section>
  );
}
