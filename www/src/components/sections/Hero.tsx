import Image from "next/image";
import { FadeInUp } from "@/components/animations/FadeInUp";
import { ScriptedOverlay } from "@/components/overlay/OverlayCard";
import { DownloadButtons } from "@/components/ui/DownloadCTA";
import { HERO_SCRIPT } from "@/content/scripts";

// Footage: Mixkit clip 48680, Mixkit License, re-encoded as a loop.
// See public/videos/SOURCE.md. Swap these files to change the call.
const CALL = { mp4: "/videos/hero-call.mp4", webm: "/videos/hero-call.webm" };
const POSTER = "/videos/hero-call.jpg";

// Savvy hears any call app through system audio; these are the common ones.
// The name sets the flex baseline, so it lines up with the sentence in any
// font; the icon centres on that line and stays shorter than it.
function App({ src, name }: { src: string; name: string }) {
  return (
    <span className="inline-flex gap-[0.3em] whitespace-nowrap">
      <span className="grid h-[1.3em] w-[1.3em] place-items-center self-center rounded-full bg-surface ring-1 ring-black/[0.06]">
        <Image src={src} alt="" width={20} height={20} className="h-[0.8em] w-[0.8em]" />
      </span>
      <span className="self-baseline">{name}</span>
    </span>
  );
}

// MacBook frame: lid with bezel and notch, then the silver base.
function MacBook({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-12 max-w-[920px]">
      <div className="relative mx-auto w-[88%] rounded-t-[14px] bg-[#0d0d0d] p-[1.2%] pb-[2%] ring-1 ring-black/50 sm:rounded-t-[20px]">
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-0 z-10 h-[2.2%] w-[11%] -translate-x-1/2 rounded-b-[6px] bg-[#0d0d0d]"
        />
        {children}
      </div>
      <div
        aria-hidden="true"
        className="relative h-[10px] rounded-b-[14px] bg-gradient-to-b from-[#e4e5e7] to-[#a7a9ac] shadow-[0_20px_40px_-20px_rgba(0,0,0,0.45)] sm:h-[18px]"
      >
        <span className="absolute left-1/2 top-0 h-1/2 w-[14%] -translate-x-1/2 rounded-b-[8px] bg-[#c6c7ca]" />
      </div>
    </div>
  );
}

function CallStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-[4px] bg-[#1d1c1a] sm:rounded-[6px]">
      <div
        className="relative aspect-[16/10] bg-cover bg-center"
        style={{ backgroundImage: `url(${POSTER})` }}
      >
        <video
          className="hero-video absolute inset-0 h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-label="A woman talking on a video call at her laptop, without audio"
          poster={POSTER}
        >
          <source src={CALL.webm} type="video/webm" />
          <source src={CALL.mp4} type="video/mp4" />
        </video>
      </div>

      {/* Left side: the speaker sits centre-right in this footage. */}
      <div className="absolute bottom-2 left-2 sm:bottom-5 sm:left-5">
        <div className="origin-bottom-left scale-[.55] sm:scale-[.8] lg:scale-100">{children}</div>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="pt-10 pb-20 lg:pt-16">
      <div className="page-column">
        <FadeInUp>
          <div className="flex justify-center">
            <p className="inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-full border border-border-soft bg-background-alt px-5 py-2 text-small">
              <span>
                Works with <App src="/images/logos/google-meet.svg" name="Meet," />{" "}
                <App src="/images/logos/microsoft-teams.svg" name="Teams" /> and{" "}
                <App src="/images/logos/zoom.svg" name="Zoom" />
              </span>
              <span aria-hidden="true" className="hidden text-muted sm:inline">
                •
              </span>
              <span className="hidden sm:inline">No bot joins</span>
            </p>
          </div>
          <h1 className="text-display mx-auto mt-6 max-w-2xl text-center text-balance">
            Know what to say, and which file says so.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-center text-lead text-balance text-muted">
            Savvy is a real-time meeting assistant that helps you negotiate your next salary, finish
            your interview strong, or close your next client.
          </p>
          <div className="mt-6">
            <DownloadButtons align="center" />
          </div>
        </FadeInUp>

        <FadeInUp delay={0.08}>
          <MacBook>
            <CallStage>
              <ScriptedOverlay script={HERO_SCRIPT} startElapsed={1483} />
            </CallStage>
          </MacBook>
        </FadeInUp>
      </div>
    </section>
  );
}
