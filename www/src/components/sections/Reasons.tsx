import { FadeInUp } from "@/components/animations/FadeInUp";
import { ScriptedOverlay } from "@/components/overlay/OverlayCard";
import {
  Eyebrow,
  FlagIcon,
  MascotNote,
  MuteIcon,
  QuestionIcon,
  SparkIcon,
  StatList,
  TwoLineHeading,
} from "@/components/sections/primitives";
import { REASONS_SCRIPT } from "@/content/scripts";

export function Reasons() {
  return (
    <section id="how" className="scroll-mt-8 py-20 lg:py-28">
      <div className="page-column grid gap-10 *:min-w-0 lg:grid-cols-[1fr_minmax(0,400px)_1fr] lg:gap-12">
        <FadeInUp>
          <Eyebrow>During the meeting</Eyebrow>
          <TwoLineHeading
            className="mt-4"
            line1="Quiet by default"
            line2="Speaks up for three reasons"
          />
          <MascotNote className="mt-8" state="thinking" note="Otherwise, it just listens." />
        </FadeInUp>

        <FadeInUp delay={0.1}>
          <div className="panel flex min-h-[380px] items-end justify-center px-4 pb-4 pt-10">
            <ScriptedOverlay script={REASONS_SCRIPT} startElapsed={2205} />
          </div>
        </FadeInUp>

        <FadeInUp delay={0.15}>
          <p className="text-sm leading-relaxed text-muted">
            Savvy checks questions against your documents, flags constraints from your brief, and
            offers advice when you ask for it.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            It also reviews recent conversation for relevant changes. A "Savvy noticed" card appears
            when it finds something concrete.
          </p>
          <StatList
            items={[
              { icon: QuestionIcon, label: "Answers their question" },
              { icon: FlagIcon, label: "Flags a red line before you cross it" },
              { icon: SparkIcon, label: "Advice when you ask for it" },
              { icon: MuteIcon, label: "Cards from the last minute of conversation" },
            ]}
          />
        </FadeInUp>
      </div>
    </section>
  );
}
