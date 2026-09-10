import { FadeInUp } from "@/components/animations/FadeInUp";
import { ScriptedOverlay } from "@/components/overlay/OverlayCard";
import { iconProps, MicIcon } from "@/components/overlay/pieces";
import { DownloadCTA, WindowsSoon } from "@/components/ui/DownloadCTA";
import { HERO_SCRIPT } from "@/content/scripts";
import { REQUIREMENTS } from "@/lib/constants";
import "./hero.css";

// Footage: Mixkit clip 10457, Mixkit License, re-encoded as a loop.
// See public/videos/SOURCE.md. Swap these files to change the call.
const CALL = { mp4: "/videos/hero-call.mp4", webm: "/videos/hero-call.webm" };
const POSTER = "/videos/hero-call.jpg";

function ControlBar() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/55 to-transparent px-4 pb-3 pt-10 sm:gap-2.5 sm:pb-4"
    >
      <span className="grid h-8 w-8 place-items-center rounded-full bg-white/15 text-white backdrop-blur-sm sm:h-9 sm:w-9">
        <MicIcon size={15} />
      </span>
      <span className="grid h-8 w-8 place-items-center rounded-full bg-white/15 text-white backdrop-blur-sm sm:h-9 sm:w-9">
        <svg {...iconProps} width="15" height="15" aria-hidden="true">
          <path d="M15 10.5 22 7v10l-7-3.5M4 5h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
        </svg>
      </span>
      <span className="grid h-8 w-8 place-items-center rounded-full bg-white/15 text-white backdrop-blur-sm sm:h-9 sm:w-9">
        <svg {...iconProps} width="15" height="15" aria-hidden="true">
          <path d="M3 4h18v12H3zM8 20h8M12 16v4" />
        </svg>
      </span>
      <span className="grid h-8 w-12 place-items-center rounded-full bg-[#e5484d] text-white sm:h-9 sm:w-14">
        <svg {...iconProps} width="16" height="16" aria-hidden="true">
          <path d="M2.5 9.5a14 14 0 0 1 19 0v3l-4 1-1-3a11 11 0 0 0-9 0l-1 3-4-1Z" />
        </svg>
      </span>
    </div>
  );
}

function CallStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-[#1d1c1a] shadow-[0_24px_60px_-24px_rgba(31,26,16,0.45)]">
      <div
        className="relative aspect-[4/5] bg-cover bg-center sm:aspect-video"
        style={{ backgroundImage: `url(${POSTER})` }}
      >
        <video
          className="hero-video absolute inset-0 h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-label="Example call footage without audio"
          poster={POSTER}
        >
          <source src={CALL.webm} type="video/webm" />
          <source src={CALL.mp4} type="video/mp4" />
        </video>

        <div
          aria-hidden="true"
          className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 backdrop-blur-sm sm:left-4 sm:top-4"
        >
          <span className="hr-rec h-1.5 w-1.5 rounded-full bg-[#ff5f57]" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-white/90">
            Rec 24:43
          </span>
        </div>
        <span
          aria-hidden="true"
          className="absolute bottom-16 left-3 rounded-md bg-black/45 px-2 py-1 text-[11px] font-medium text-white/90 backdrop-blur-sm sm:left-4"
        >
          Acme Industrial
        </span>

        <ControlBar />
      </div>

      <div className="absolute inset-x-0 bottom-14 flex justify-center px-3 sm:bottom-16 sm:justify-end sm:pr-5">
        <div className="w-full origin-bottom scale-[.92] sm:w-auto sm:scale-100">{children}</div>
      </div>
    </div>
  );
}

/**
 * The margin note: two handwritten lines and an arrow back to the call. It
 * hangs in the gutter beside the frame from xl, where the content column
 * leaves room for it, and sits under the frame below that — so each direction
 * gets its own path rather than a rotated one (rotation clips inside the
 * viewBox).
 */
const NOTE = ["Reads your files first.", "Then whispers, mid-call."];

const sketch = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function MarginNote({ side }: { side: "right" | "below" }) {
  const lines = (
    <p className="font-hand text-[20px] leading-[1.25] text-muted">
      {NOTE[0]}
      <br />
      {NOTE[1]}
    </p>
  );

  if (side === "below") {
    return (
      <div className="mx-auto mt-8 max-w-xs text-center xl:hidden">
        <svg
          className="hr-arrow mx-auto h-12 w-14 text-muted"
          viewBox="0 0 56 48"
          aria-hidden="true"
          {...sketch}
        >
          <path d="M17 45c11-3 17-13 17-27 0-4-.5-8-1-12" />
          <path d="M26 9 33 2l7 8" />
        </svg>
        {lines}
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute left-full top-8 hidden w-[210px] pl-4 xl:block">
      <svg
        className="hr-arrow h-14 w-24 text-muted"
        viewBox="0 0 96 56"
        aria-hidden="true"
        {...sketch}
      >
        <path d="M92 4c-2 20-14 33-34 38-9 2-19 3-30 2" />
        <path d="M37 36 27 44l11 7" />
      </svg>
      <div className="mt-1">{lines}</div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="pt-8 pb-16 lg:pt-10">
      <div className="page-column">
        <FadeInUp>
          <h1 className="mx-auto max-w-3xl text-center text-[42px] font-medium leading-[1.04] tracking-tighter sm:text-6xl lg:text-[76px]">
            Your notes,
            <br />
            when you need them.
          </h1>
        </FadeInUp>

        {/* The call frame is the hero: centred on the page, with the note
            hanging in the gutter beside it rather than claiming a column of
            its own, so the composition stays symmetrical. */}
        <FadeInUp delay={0.1}>
          <div className="relative mx-auto mt-10 w-full max-w-[680px]">
            <MarginNote side="right" />
            <CallStage>
              <ScriptedOverlay script={HERO_SCRIPT} startElapsed={1483} />
            </CallStage>
          </div>
          <MarginNote side="below" />
        </FadeInUp>

        <FadeInUp delay={0.2}>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <DownloadCTA />
            <WindowsSoon />
          </div>
          <p className="mt-4 text-center font-mono text-[11px] text-muted">{REQUIREMENTS}</p>
          <p className="mt-2 text-center text-xs text-muted">
            Illustrative demo with example documents and guidance.
          </p>
        </FadeInUp>
      </div>
    </section>
  );
}
