import { FadeInUp } from "@/components/animations/FadeInUp";
import { ScriptedOverlay } from "@/components/overlay/OverlayCard";
import { DownloadCTA } from "@/components/ui/DownloadCTA";
import { HERO_SCRIPT } from "@/content/scripts";
import { REPO_URL, REQUIREMENTS } from "@/lib/constants";

// Footage: Mixkit clips 10457 (the other side) and 41208 (self view), Mixkit
// License, re-encoded as seamless loops. See public/videos/SOURCE.md.
const CALL = { mp4: "/videos/hero-call.mp4", webm: "/videos/hero-call.webm" };
const SELF = { mp4: "/videos/hero-self.mp4", webm: "/videos/hero-self.webm" };
const POSTER = "/videos/hero-call.jpg";

function Clip({
  src,
  className,
  poster,
}: {
  src: { mp4: string; webm: string };
  className: string;
  poster?: string;
}) {
  return (
    <video className={`hero-video ${className}`} autoPlay muted loop playsInline poster={poster}>
      <source src={src.webm} type="video/webm" />
      <source src={src.mp4} type="video/mp4" />
    </video>
  );
}

/** A Mac window playing a muted call recording, with the live card floating
 *  over it exactly where the real overlay sits: bottom centre of the screen.
 *  Replace the files in public/videos to swap the footage. */
function CallWindow({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative mx-auto w-full max-w-3xl">
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-[0_24px_60px_-24px_rgba(31,26,16,0.4)]">
        <div className="flex h-9 items-center gap-2 border-b border-border-soft bg-background-alt px-3.5">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          <span className="ml-3 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" />
            Acme renewal
          </span>
        </div>
        <div
          className="relative aspect-[4/5] bg-[#1d1c1a] bg-cover bg-center sm:aspect-video"
          style={{ backgroundImage: `url(${POSTER})` }}
        >
          <Clip
            src={CALL}
            poster={POSTER}
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
          <div className="absolute left-3 top-3 hidden w-[22%] overflow-hidden rounded-lg shadow-lg ring-1 ring-white/25 sm:block">
            <Clip src={SELF} className="aspect-video w-full object-cover" />
            <span className="absolute bottom-1.5 left-2 rounded bg-black/45 px-1.5 py-0.5 font-mono text-[9px] text-white/90">
              You
            </span>
          </div>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-3 flex justify-center px-3 sm:bottom-4 sm:justify-end sm:pr-5">
        <div className="w-full origin-bottom scale-[.92] sm:w-auto sm:scale-100">{children}</div>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="pt-8 pb-16 text-center lg:pt-10">
      <div className="page-column">
        <FadeInUp>
          <h1 className="mx-auto max-w-3xl text-[42px] font-medium leading-[1.04] tracking-tighter sm:text-6xl lg:text-[76px]">
            Hard question?
            <br />
            You already know.
          </h1>
        </FadeInUp>

        <FadeInUp delay={0.1}>
          <div className="mt-10">
            <CallWindow>
              <ScriptedOverlay script={HERO_SCRIPT} startElapsed={1483} />
            </CallWindow>
          </div>
        </FadeInUp>

        <FadeInUp delay={0.2}>
          <p className="mx-auto mt-8 max-w-xl text-sm leading-relaxed text-muted">
            Savvy reads your documents before the meeting, then listens alongside you and whispers
            what to say, what to avoid, and which file says so. A small card on your Mac. Nothing
            joins the call.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
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
          <p className="mt-4 font-mono text-[11px] text-muted">{REQUIREMENTS}</p>
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
