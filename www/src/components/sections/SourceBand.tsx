import type { CSSProperties } from "react";
import { FadeInUp } from "@/components/animations/FadeInUp";
import { MascotNote, TwoLineHeading } from "@/components/sections/primitives";

type Pod = {
  key: string;
  title: "Answer" | "Red line" | "Advice" | "Savvy noticed";
  say: string;
  source: string;
  grounded: number;
  className: string;
  orbit: { r: number; dur: number; delay: number; reverse?: boolean };
  layer: "front" | "back";
};

const PODS: Pod[] = [
  {
    key: "terms",
    title: "Answer",
    say: "Net-60, not net-90.",
    source: "payment-terms.pdf · p.2",
    grounded: 94,
    className: "-left-6 top-[1%] md:left-[8%] md:top-[22%]",
    orbit: { r: 37, dur: 16, delay: -3 },
    layer: "back",
  },
  {
    key: "q1",
    title: "Red line",
    say: "No Q1 go-live.",
    source: "brief · Red lines",
    grounded: 100,
    className: "-right-8 top-[4%] md:right-[6%] md:top-[16%]",
    orbit: { r: 35, dur: 19, delay: -9, reverse: true },
    layer: "back",
  },
  {
    key: "owner",
    title: "Savvy noticed",
    say: "Nobody owns legal review.",
    source: "transcript · last 60 s",
    grounded: 88,
    className: "-left-8 bottom-[4%] md:bottom-[26%] md:left-[4%]",
    orbit: { r: 32, dur: 14, delay: -6 },
    layer: "back",
  },
  {
    key: "dpa",
    title: "Answer",
    say: "Data stays in the EU.",
    source: "dpa-addendum.docx · §4",
    grounded: 96,
    className: "-right-6 bottom-[1%] md:bottom-[20%] md:right-[8%]",
    orbit: { r: 38, dur: 17, delay: -12, reverse: true },
    layer: "front",
  },
  {
    key: "rank",
    title: "Advice",
    say: "Ask them to rank the three.",
    source: "brief · Questions to ask",
    grounded: 91,
    className: "hidden lg:block lg:left-[26%] lg:top-[7%]",
    orbit: { r: 27, dur: 15, delay: -2 },
    layer: "front",
  },
  {
    key: "discount",
    title: "Red line",
    say: "Discount stays under 15%.",
    source: "brief · Prohibited claims",
    grounded: 100,
    className: "hidden lg:block lg:right-[26%] lg:top-[8%]",
    orbit: { r: 28, dur: 13, delay: -7, reverse: true },
    layer: "back",
  },
  {
    key: "onboarding",
    title: "Answer",
    say: "Four weeks, named CSM.",
    source: "kickoff-deck.pptx · slide 6",
    grounded: 93,
    className: "hidden xl:block xl:left-[4%] xl:top-[48%]",
    orbit: { r: 33, dur: 18, delay: -14 },
    layer: "back",
  },
  {
    key: "scope",
    title: "Savvy noticed",
    say: "Scope grew, date didn't.",
    source: "transcript · last 60 s",
    grounded: 86,
    className: "hidden xl:block xl:right-[4%] xl:top-[46%]",
    orbit: { r: 36, dur: 12.5, delay: -5, reverse: true },
    layer: "back",
  },
  {
    key: "soc2",
    title: "Answer",
    say: "SOC 2 Type II, March.",
    source: "soc2-report.pdf · p.1",
    grounded: 97,
    className: "hidden lg:block lg:bottom-[8%] lg:left-[38%]",
    orbit: { r: 30, dur: 14.5, delay: -10 },
    layer: "front",
  },
];

const DocGlyph = (
  <svg
    viewBox="0 0 24 24"
    width="11"
    height="11"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4" />
  </svg>
);

const TONE: Record<Pod["title"], string> = {
  Answer: "bg-success/10 text-success",
  "Red line": "bg-danger/10 text-danger",
  Advice: "bg-black/5 text-[#111]",
  "Savvy noticed": "bg-warning/10 text-warning",
};

function PodCard({ title, say, source, grounded }: Pod) {
  return (
    <div className="w-52 p-3 text-[#111] md:w-60">
      <div className="flex items-center gap-2">
        <span className={`rounded-md px-1.5 py-0.5 text-[12px] font-semibold ${TONE[title]}`}>
          {title}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-black/55">{grounded}%</span>
      </div>
      <p className="mt-2 text-[14px] font-semibold leading-snug">{say}</p>
      <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-[#f6f5f2] px-2 py-1 font-mono text-[11px] text-black/55">
        {DocGlyph}
        <span className="truncate">{source}</span>
      </p>
    </div>
  );
}

export function SourceBand() {
  return (
    <section className="pt-20 lg:pt-28">
      <div className="page-column">
        <FadeInUp>
          <TwoLineHeading
            line1="See the supporting source"
            line2="Documents, brief, and conversation"
          />
        </FadeInUp>
      </div>

      <FadeInUp delay={0.1}>
        <div className="page-column">
          <div className="art-panel art-paper relative mt-10 overflow-hidden text-foreground">
            {PODS.map((pod) => (
              <div
                key={pod.key}
                className={`absolute ${pod.layer === "front" ? "z-20" : "z-0"} ${pod.className}`}
              >
                <div
                  className={`pod-orbit ${pod.orbit.reverse ? "pod-orbit-reverse" : ""}`}
                  style={
                    {
                      "--pod-r": `${pod.orbit.r}px`,
                      "--pod-dur": `${pod.orbit.dur}s`,
                      animationDelay: `${pod.orbit.delay}s`,
                    } as CSSProperties
                  }
                >
                  <div
                    className={`rounded-2xl bg-surface shadow-[0_12px_32px_-16px_rgba(31,26,16,0.45)] ring-1 ring-black/[0.06] ${
                      pod.layer === "back" ? "opacity-70" : ""
                    }`}
                  >
                    <PodCard {...pod} />
                  </div>
                </div>
              </div>
            ))}

            <div className="relative z-10 px-4 py-32 lg:py-44">
              <div className="art-card mx-auto max-w-md px-6 py-8 text-center">
                <p className="text-display">Check the source.</p>
                <p className="mx-auto mt-4 max-w-sm text-small text-balance text-muted">
                  Cards cite your documents, brief, or conversation. Review the source before
                  acting.
                </p>
                <MascotNote
                  className="mt-8 justify-center"
                  state="listening"
                  note="Every card names its source."
                />
              </div>
            </div>
          </div>
        </div>
      </FadeInUp>
    </section>
  );
}
