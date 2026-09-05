import { type BandPod, PodBand } from "@/components/sections/PodBand";

// The money.x.com stat band, repurposed: recommendation cards drift around one
// claim, each carrying the file it was grounded in. Same nine anchor
// positions as the sibling site so the choreography is known-good.

type Pod = {
  key: string;
  title: "Answer" | "Red line" | "Advice" | "Savvy noticed";
  say: string;
  source: string;
  grounded: number;
  className: string;
  orbit: BandPod["orbit"];
  tilt: number;
  layer: BandPod["layer"];
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
    tilt: -2,
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
    tilt: 2.5,
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
    tilt: 1.5,
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
    tilt: -1.5,
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
    tilt: 3,
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
    tilt: -3,
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
    tilt: 2,
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
    tilt: -2.5,
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
    tilt: 1,
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
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4" />
  </svg>
);

const TONE: Record<Pod["title"], string> = {
  Answer: "bg-success",
  "Red line": "bg-danger",
  Advice: "bg-accent",
  "Savvy noticed": "bg-warning",
};

/** Compact recommendation: title, one short Say line, the cited file. */
function PodCard({ title, say, source, grounded }: Pod) {
  return (
    <div className="w-48 px-3.5 py-3 md:w-56">
      <div className="flex items-center gap-2">
        <span className={`h-[7px] w-[7px] rounded-full ${TONE[title]}`} />
        <span className="text-[11px] font-bold">{title}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted">{grounded}%</span>
      </div>
      <p className="mt-2 text-[13px] leading-snug tracking-tight">
        <span className="mr-1.5 text-[9px] font-extrabold uppercase tracking-[0.08em] text-success">
          Say
        </span>
        {say}
      </p>
      <p className="mt-2 flex items-center gap-1.5 truncate font-mono text-[10px] text-muted">
        {DocGlyph}
        <span className="truncate">{source}</span>
      </p>
    </div>
  );
}

const BAND_PODS: BandPod[] = PODS.map((pod) => ({
  key: pod.key,
  className: pod.className,
  orbit: pod.orbit,
  tilt: pod.tilt,
  layer: pod.layer,
  card: <PodCard {...pod} />,
}));

export function SourceBand() {
  return (
    <PodBand
      eyebrow="Grounded"
      line1="Every card cites a file"
      line2="Say, avoid, and the page"
      pods={BAND_PODS}
      stat="Grounded, not guessed."
      caption="Every recommendation is built from your own documents and the brief you approved, and shows the file it leaned on."
    />
  );
}
