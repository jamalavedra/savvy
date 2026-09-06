import type { ReactNode } from "react";
import { FadeInUp } from "@/components/animations/FadeInUp";
import { TwoLineHeading } from "@/components/sections/primitives";
import {
  AdviceVignette,
  BriefVignette,
  ChannelsVignette,
  FolderVignette,
  HistoryVignette,
  SayAvoidVignette,
} from "@/components/sections/vignettes";

// Numbered bento — the "One app / Everything money can do" section from
// money.x.com: square media card with the text column BESIDE it (number top,
// title+body bottom). Vignettes are icon-and-motion loops, not prose.

type Item = { n: number; title: string; body: string; vignette: ReactNode };

function BentoItem({ item, tall }: { item: Item; tall?: boolean }) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:gap-5">
      <div
        className={`flex flex-1 items-center justify-center overflow-hidden bg-background-alt p-5 ${
          tall ? "min-h-72" : "min-h-64"
        }`}
      >
        {item.vignette}
      </div>
      <div className="shrink-0 md:flex md:w-40 md:flex-col md:justify-between lg:w-52">
        <span className="font-mono text-xs text-muted">{String(item.n).padStart(2, "0")}</span>
        <div className="mt-2 md:mt-0">
          <h3 className="text-sm font-semibold">{item.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.body}</p>
        </div>
      </div>
    </div>
  );
}

const ITEMS: Item[] = [
  {
    n: 1,
    title: "Point it at a folder",
    body: "PDF, DOCX, PPTX, XLSX, CSV, Markdown, EPUB. Indexed read-only, never copied.",
    vignette: <FolderVignette />,
  },
  {
    n: 2,
    title: "A brief you approve",
    body: "Objective, both positions, red lines, questions to ask. Generated from the folder or imported, then approved by you.",
    vignette: <BriefVignette />,
  },
  {
    n: 3,
    title: "Hears both sides",
    body: "Microphone and system audio, labelled separately, in whatever language the meeting is in. No bot joins the call.",
    vignette: <ChannelsVignette />,
  },
  {
    n: 4,
    title: "Say and avoid",
    body: "One thing to say, one to avoid, a grounding score and the file. Cards expire unless you keep them.",
    vignette: <SayAvoidVignette />,
  },
  {
    n: 5,
    title: "Advice on demand",
    body: "Press Advice, or the shortcut, for a read on the room from the brief and the last minute of talk.",
    vignette: <AdviceVignette />,
  },
  {
    n: 6,
    title: "Meetings stay on this Mac",
    body: "Recordings and transcripts are saved locally and deleted after 30 days.",
    vignette: <HistoryVignette />,
  },
];

function pick(n: number): Item {
  const item = ITEMS[n];
  if (!item) throw new Error(`Bento item ${n} is missing`);
  return item;
}

export function Everything() {
  return (
    <section id="features" className="scroll-mt-8 py-20 lg:py-28">
      <div className="page-column">
        <FadeInUp>
          <TwoLineHeading line1="One small app" line2="Before, during, after" />
        </FadeInUp>

        <div className="mt-12 flex flex-col gap-14">
          <div className="grid gap-14 md:grid-cols-2 md:gap-10">
            <FadeInUp>
              <BentoItem item={pick(0)} />
            </FadeInUp>
            <FadeInUp delay={0.05}>
              <BentoItem item={pick(1)} />
            </FadeInUp>
          </div>
          <FadeInUp>
            <BentoItem item={pick(2)} tall />
          </FadeInUp>
          <div className="grid gap-14 md:grid-cols-2 md:gap-10">
            <FadeInUp>
              <BentoItem item={pick(3)} />
            </FadeInUp>
            <FadeInUp delay={0.05}>
              <BentoItem item={pick(4)} />
            </FadeInUp>
          </div>
          <FadeInUp>
            <BentoItem item={pick(5)} tall />
          </FadeInUp>
        </div>
      </div>
    </section>
  );
}
