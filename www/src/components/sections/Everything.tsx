import type { CSSProperties, ReactNode } from "react";
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

type Item = { n: number; title: string; body: string; hue: string; vignette: ReactNode };

function BentoItem({ item, tall }: { item: Item; tall?: boolean }) {
  return (
    <div
      className="flex flex-col gap-4 md:flex-row md:gap-5"
      style={{ "--hue": item.hue } as CSSProperties}
    >
      <div
        className={`panel flex flex-1 items-center justify-center overflow-hidden p-5 ${
          tall ? "min-h-72" : "min-h-64"
        }`}
      >
        {item.vignette}
      </div>
      <div className="shrink-0 md:flex md:w-40 md:flex-col md:justify-between lg:w-52">
        <span className="panel-numeral font-mono text-xs">{String(item.n).padStart(2, "0")}</span>
        <div className="mt-2 md:mt-0">
          <h3 className="text-sm font-semibold">{item.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.body}</p>
        </div>
      </div>
    </div>
  );
}

const ITEMS = [
  {
    n: 1,
    title: "Point it at a folder",
    body: "PDF, DOCX, PPTX, XLSX, CSV, Markdown, EPUB. Source files stay in place. Savvy indexes extracted text on your Mac.",
    hue: "var(--color-hue-sky)",
    vignette: <FolderVignette />,
  },
  {
    n: 2,
    title: "A brief you approve",
    body: "Objective, both positions, red lines, questions. Generate from your folder or import a brief, then approve it.",
    hue: "var(--color-hue-butter)",
    vignette: <BriefVignette />,
  },
  {
    n: 3,
    title: "Hears both sides",
    body: "Microphone and system audio, labelled separately, with selectable transcription languages. No bot joins the call.",
    hue: "var(--color-hue-lilac)",
    vignette: <ChannelsVignette />,
  },
  {
    n: 4,
    title: "Say and avoid",
    body: "One thing to say, one to avoid, a grounding score and the file. Cards expire unless you keep them.",
    hue: "var(--color-hue-sage)",
    vignette: <SayAvoidVignette />,
  },
  {
    n: 5,
    title: "Advice on demand",
    body: "Press Advice, or the shortcut, for guidance based on your brief and recent conversation.",
    hue: "var(--color-hue-pink)",
    vignette: <AdviceVignette />,
  },
  {
    n: 6,
    title: "Local meeting history",
    body: "Savvy saves recordings and transcripts on your Mac and deletes those older than 30 days at startup.",
    hue: "var(--color-hue-sky)",
    vignette: <HistoryVignette />,
  },
] as const satisfies readonly Item[];

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
              <BentoItem item={ITEMS[0]} />
            </FadeInUp>
            <FadeInUp delay={0.05}>
              <BentoItem item={ITEMS[1]} />
            </FadeInUp>
          </div>
          <FadeInUp>
            <BentoItem item={ITEMS[2]} tall />
          </FadeInUp>
          <div className="grid gap-14 md:grid-cols-2 md:gap-10">
            <FadeInUp>
              <BentoItem item={ITEMS[3]} />
            </FadeInUp>
            <FadeInUp delay={0.05}>
              <BentoItem item={ITEMS[4]} />
            </FadeInUp>
          </div>
          <FadeInUp>
            <BentoItem item={ITEMS[5]} tall />
          </FadeInUp>
        </div>
      </div>
    </section>
  );
}
