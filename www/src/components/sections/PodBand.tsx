import type { CSSProperties, ReactNode } from "react";
import { FadeInUp } from "@/components/animations/FadeInUp";
import { Eyebrow, TwoLineHeading } from "@/components/sections/primitives";

// The money.x.com stat band: one giant claim with rectangular cards orbiting
// around it. Cards on the "back" layer slide behind the claim and are blurred;
// the claim carries a backdrop blur so anything drifting behind it softens.

export type BandPod = {
  key: string;
  /** Position utilities. Author a mobile position first, then md: overrides. */
  className: string;
  orbit: { r: number; dur: number; delay: number; reverse?: boolean };
  tilt: number;
  /** front = passes translucently above the claim; back = slides behind it */
  layer: "front" | "back";
  card: ReactNode;
};

export function PodBand({
  eyebrow,
  line1,
  line2,
  pods,
  stat,
  caption,
}: {
  eyebrow: string;
  line1: string;
  line2: string;
  pods: BandPod[];
  stat: ReactNode;
  caption: string;
}) {
  return (
    <section className="pt-20 lg:pt-28">
      <div className="page-column">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <FadeInUp>
            <Eyebrow>{eyebrow}</Eyebrow>
          </FadeInUp>
          <FadeInUp delay={0.05}>
            <TwoLineHeading className="lg:max-w-xl lg:text-right" line1={line1} line2={line2} />
          </FadeInUp>
        </div>
      </div>

      <FadeInUp delay={0.1}>
        <div className="page-column">
          <div className="relative mt-14 overflow-hidden bg-background-alt text-foreground">
            {pods.map((pod) => (
              <div
                key={pod.key}
                className={`absolute ${
                  pod.layer === "front" ? "z-20" : "z-0 blur-[2px] md:blur-[3px]"
                } ${pod.className}`}
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
                    className={`bg-surface/80 shadow-sm backdrop-blur-sm ${
                      pod.layer === "back" ? "opacity-80" : ""
                    }`}
                    style={{ transform: `rotate(${pod.tilt}deg)` }}
                  >
                    {pod.card}
                  </div>
                </div>
              </div>
            ))}

            <div className="relative z-10 px-6 py-32 text-center backdrop-blur-[3px] lg:py-44">
              <p className="text-5xl font-medium tracking-tighter sm:text-6xl lg:text-7xl">
                {stat}
              </p>
              <p className="mx-auto mt-4 max-w-md text-sm text-balance text-muted">{caption}</p>
            </div>
          </div>
        </div>
      </FadeInUp>
    </section>
  );
}
