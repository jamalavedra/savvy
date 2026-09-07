import { FadeInUp } from "@/components/animations/FadeInUp";
import { ScriptedOverlay } from "@/components/overlay/OverlayCard";
import { DownloadCTA } from "@/components/ui/DownloadCTA";
import { HERO_SCRIPT } from "@/content/scripts";
import { REPO_URL, REQUIREMENTS } from "@/lib/constants";
import "./hero.css";

// Footage: Mixkit clip 10457, Mixkit License, re-encoded as a seamless loop.
// See public/videos/SOURCE.md. Swap these files to change the call.
const CALL = { mp4: "/videos/hero-call.mp4", webm: "/videos/hero-call.webm" };
const POSTER = "/videos/hero-call.jpg";

const control = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** Meeting-app control bar: the furniture that makes the frame read as a call
 *  rather than a video embed. Decorative — none of it is interactive. */
function ControlBar() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/55 to-transparent px-4 pb-3 pt-10 sm:gap-2.5 sm:pb-4"
    >
      <span className="grid h-8 w-8 place-items-center rounded-full bg-white/15 text-white backdrop-blur-sm sm:h-9 sm:w-9">
        <svg {...control} width="15" height="15" aria-hidden="true">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
        </svg>
      </span>
      <span className="grid h-8 w-8 place-items-center rounded-full bg-white/15 text-white backdrop-blur-sm sm:h-9 sm:w-9">
        <svg {...control} width="15" height="15" aria-hidden="true">
          <path d="M15 10.5 22 7v10l-7-3.5M4 5h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
        </svg>
      </span>
      <span className="grid h-8 w-8 place-items-center rounded-full bg-white/15 text-white backdrop-blur-sm sm:h-9 sm:w-9">
        <svg {...control} width="15" height="15" aria-hidden="true">
          <path d="M3 4h18v12H3zM8 20h8M12 16v4" />
        </svg>
      </span>
      <span className="grid h-8 w-12 place-items-center rounded-full bg-[#e5484d] text-white sm:h-9 sm:w-14">
        <svg {...control} width="16" height="16" aria-hidden="true">
          <path d="M2.5 9.5a14 14 0 0 1 19 0v3l-4 1-1-3a11 11 0 0 0-9 0l-1 3-4-1Z" />
        </svg>
      </span>
    </div>
  );
}

/** The call, with Savvy's panel floating over it the way it does on a real
 *  Mac: above the meeting window, bottom of the screen, nothing joining. */
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
            Rec 24:50
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

/** Hand-drawn arrows from the note to the panel: it sits beside the call on
 *  wide screens and under it on narrow ones, so each direction gets its own
 *  path rather than a rotated one (rotation clips inside the viewBox). */
function Arrow() {
  return (
    <>
      <svg
        className="hr-arrow mx-auto h-16 w-16 text-muted lg:hidden"
        viewBox="0 0 64 64"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 58c14-4 21-14 22-30 0-6-1-12-2-18" />
        <path d="M32 16 40 8l8 9" />
      </svg>
      <svg
        className="hr-arrow hidden text-muted lg:block lg:h-20 lg:w-24"
        viewBox="0 0 96 80"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M86 6c4 26-6 44-30 52-10 3-21 4-33 3" />
        <path d="M31 51 23 61l12 6" />
      </svg>
    </>
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

        <FadeInUp delay={0.1}>
          <div className="mt-10 flex flex-col items-center gap-6 lg:flex-row lg:items-center lg:gap-8">
            <div className="w-full min-w-0 lg:flex-1">
              <CallStage>
                <ScriptedOverlay script={HERO_SCRIPT} startElapsed={1483} />
              </CallStage>
            </div>

            <div className="max-w-sm shrink-0 text-center lg:w-60 lg:text-left xl:w-64">
              <Arrow />
              <p className="mt-1 text-sm leading-relaxed text-muted">
                Prepare from your documents, then get suggestions during a conversation. Savvy shows
                what to say, what to avoid, and the supporting source in a small panel on your Mac.
              </p>
              <p className="mt-3 text-xs text-muted">
                Illustrative demo with example documents and guidance.
              </p>
            </div>
          </div>
        </FadeInUp>

        <FadeInUp delay={0.2}>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <DownloadCTA />
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-background-alt"
            >
              <GitHubIcon />
              View on GitHub
            </a>
          </div>
          <p className="mt-4 text-center font-mono text-[11px] text-muted">{REQUIREMENTS}</p>
        </FadeInUp>
      </div>
    </section>
  );
}

export function GitHubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}
