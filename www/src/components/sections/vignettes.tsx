import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";
import { iconProps, MicIcon, StatusLine, WAVE } from "@/components/overlay/pieces";
import { RecommendationCard } from "@/components/overlay/RecommendationCard";
import { CHECK_PATH } from "@/components/sections/primitives";

// Every vignette sits inside the white art card: a header line, then rows on
// the inset grey. Labels are sentence case, figures and paths are mono.

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg {...iconProps} strokeWidth={1.5} width={size} height={size} aria-hidden="true">
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
  speaker: "M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
  play: "M8 5v14l11-7z",
  trash:
    "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
};

function Head({ icon, title, meta }: { icon: string; title: string; meta?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 pb-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-[#f6f5f2] text-[#111]">
        <Icon d={icon} />
      </span>
      <span className="text-[16px] font-semibold text-[#111]">{title}</span>
      {meta && <span className="ml-auto">{meta}</span>}
    </div>
  );
}

function Row({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-3 rounded-[14px] bg-[#f6f5f2] px-3.5 py-3 ${className}`}>
      {children}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[13px] font-medium leading-tight text-black/55">{children}</span>;
}

function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "up" }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium leading-4 ${
        tone === "up" ? "bg-[#1f7a35]/10 text-[#1f7a35]" : "bg-black/5 text-black/55"
      }`}
    >
      {children}
    </span>
  );
}

const vignette = "sv w-full max-w-[380px]";

// Official app logos where the format has one; CSV and EPUB get a plain page.
const KINDS: { kind: string; logo?: string }[] = [
  { kind: "PDF", logo: "/images/files/pdf.svg" },
  { kind: "DOCX", logo: "/images/files/microsoft-word.svg" },
  { kind: "PPTX", logo: "/images/files/microsoft-powerpoint.svg" },
  { kind: "XLSX", logo: "/images/files/microsoft-excel.svg" },
  { kind: "MD", logo: "/images/files/markdown-light.svg" },
  { kind: "CSV" },
  { kind: "EPUB" },
];

function FileLogo({ kind, logo }: { kind: string; logo?: string }) {
  return (
    <span className="flex flex-col items-center gap-1">
      <span className="grid h-12 w-12 place-items-center rounded-[13px] bg-white ring-1 ring-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
        {logo ? (
          <Image src={logo} alt="" width={28} height={28} className="h-7 w-7 object-contain" />
        ) : (
          <span className="grid h-7 w-[22px] place-items-end rounded-[3px] bg-[#f6f5f2] pb-0.5 font-mono text-[7px] font-semibold text-[#111] ring-1 ring-black/10">
            <span className="w-full text-center">{kind}</span>
          </span>
        )}
      </span>
      <span className="font-mono text-[10px] font-medium text-black/55">{kind}</span>
    </span>
  );
}

export function FolderVignette() {
  return (
    <div className={vignette}>
      <Head icon={D.folder} title="Sources" meta={<Tag tone="up">Read-only</Tag>} />
      <Row className="flex-wrap justify-center gap-x-3.5 gap-y-2.5 px-2.5 py-3">
        {KINDS.map((k) => (
          <FileLogo key={k.kind} {...k} />
        ))}
      </Row>
      <Row className="mt-2">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#1f7a35]" />
        <Label>Indexed on your Mac</Label>
        <span className="ml-auto font-mono text-[12px] text-black/55">14</span>
      </Row>
    </div>
  );
}

// Example brief, same deal as the other demo cards.
const BRIEF_ROWS = [
  { icon: D.target, label: "Objective", lines: ["Renew the annual at net-60."] },
  { icon: D.flag, label: "Red lines", lines: ["No Q1 go-live.", "Discount stays under 15%."] },
  { icon: D.question, label: "Questions", lines: ["Ask them to rank the three."] },
];

export function BriefVignette() {
  return (
    <div className={vignette}>
      <Head
        icon={D.fileText}
        title="Brief"
        meta={
          <span className="check-pop inline-flex">
            <Tag tone="up">
              <Icon d={CHECK_PATH} size={12} />
              Approved
            </Tag>
          </span>
        }
      />
      <div className="flex flex-col gap-2">
        {BRIEF_ROWS.map((row) => (
          <Row key={row.label} className="items-start">
            <span className="mt-px text-black/55">
              <Icon d={row.icon} size={14} />
            </span>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label>{row.label}</Label>
              {row.lines.map((line) => (
                <span key={line} className="text-[14px] font-medium leading-snug text-[#111]">
                  {line}
                </span>
              ))}
            </div>
          </Row>
        ))}
      </div>
    </div>
  );
}

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

const LANGS = [
  { code: "EN", flag: "/images/flags/gb.svg" },
  { code: "ES", flag: "/images/flags/es.svg" },
  { code: "CA", flag: "/images/flags/es-ct.svg" },
  { code: "DE", flag: "/images/flags/de.svg" },
];

export function ChannelsVignette() {
  return (
    <div className={vignette}>
      <Head icon={D.speaker} title="Audio" meta={<Label>Auto detect</Label>} />
      <div className="flex flex-col gap-2">
        <Row>
          <span className="w-24 shrink-0">
            <Label>System audio</Label>
          </span>
          <Wave cls="talk-a" />
        </Row>
        <Row>
          <span className="flex w-24 shrink-0 items-center gap-1.5 text-black/55">
            <MicIcon size={12} />
            <Label>Microphone</Label>
          </span>
          <Wave cls="talk-b" />
        </Row>
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        {LANGS.map((lang, i) => (
          <span
            key={lang.code}
            className={`inline-flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 font-mono text-[11px] font-medium ${
              i === 0 ? "bg-[#111] text-white" : "bg-black/5 text-black/55"
            }`}
          >
            <Image
              src={lang.flag}
              alt=""
              width={16}
              height={16}
              className="h-4 w-4 rounded-full ring-1 ring-black/10"
            />
            {lang.code}
          </span>
        ))}
      </div>
    </div>
  );
}

export function SayAvoidVignette() {
  return (
    <div className="sv sv-loop w-full max-w-[320px] [zoom:1.15]">
      <RecommendationCard
        rec={{
          title: "Answer",
          say: "Net-60, if the annual stays.",
          avoid: "Don't quote net-90.",
          grounded: 94,
          source: "payment-terms.pdf · p.2",
        }}
        lifetime="6s"
      />
    </div>
  );
}

export function AdviceVignette() {
  return (
    <div className="sv [zoom:1.3]">
      <div className="scard">
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
              <MicIcon />
            </span>
          </div>
          <Wave cls="" />
          <div className="sbase-r">
            <kbd className="rounded-md bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-black/55">
              ⌥⇧S
            </kbd>
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryRow({
  title,
  when,
  minutes,
  playing = false,
  expiring = false,
}: {
  title: string;
  when: string;
  minutes: string;
  playing?: boolean;
  expiring?: boolean;
}) {
  return (
    <Row>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white text-[#111] ring-1 ring-black/[0.06]">
        <Icon d={expiring ? D.trash : D.play} size={12} />
      </span>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold leading-tight text-[#111]">
          {title}
        </span>
        <Label>{when}</Label>
        <div className="mt-1.5 h-1 rounded-full bg-black/[0.08]">
          {playing && (
            <div className="playhead h-1 rounded-full bg-[#111]" style={{ width: "30%" }} />
          )}
        </div>
      </div>
      <span className={`font-mono text-[12px] ${expiring ? "text-[#b4380a]" : "text-black/55"}`}>
        {expiring ? "30d" : minutes}
      </span>
    </Row>
  );
}

export function HistoryVignette() {
  return (
    <div className={vignette}>
      <Head icon={D.play} title="Meetings" meta={<Label>On your Mac</Label>} />
      <div className="flex flex-col gap-2">
        <HistoryRow title="Acme renewal" when="Today" minutes="42 min" playing />
        <HistoryRow title="Northwind kickoff" when="Yesterday" minutes="27 min" />
        <HistoryRow title="Pricing review" when="30 days ago" minutes="51 min" expiring />
      </div>
    </div>
  );
}
