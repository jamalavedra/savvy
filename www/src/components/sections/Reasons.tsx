import { FadeInUp } from "@/components/animations/FadeInUp";
import { ScriptedOverlay } from "@/components/overlay/OverlayCard";
import {
  Eyebrow,
  FlagIcon,
  MuteIcon,
  QuestionIcon,
  SparkIcon,
  StatList,
  TwoLineHeading,
} from "@/components/sections/primitives";
import { REASONS_SCRIPT } from "@/content/scripts";

// Three-column beat (heading | product | body): the behaviour that separates
// Savvy from copilots that narrate — it is quiet until one of three triggers.
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
        </FadeInUp>

        <FadeInUp delay={0.1}>
          <div className="flex min-h-[380px] items-end justify-center bg-background-alt px-4 pb-4 pt-10">
            <ScriptedOverlay script={REASONS_SCRIPT} startElapsed={2205} />
          </div>
        </FadeInUp>

        <FadeInUp delay={0.15}>
          <p className="text-sm leading-relaxed text-muted">
            Most meeting copilots narrate. Savvy waits. The mascot switches to thinking for exactly
            three reasons: the other side asked a question, someone touched a red line from your
            brief, or you pressed Advice.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Between those it re-reads your brief and notes against the last minute of conversation
            and only interrupts with a card labelled Savvy noticed when it has something concrete.
            No generic coaching, no play-by-play.
          </p>
          <StatList
            items={[
              { icon: QuestionIcon, label: "Answers their question" },
              { icon: FlagIcon, label: "Flags a red line before you cross it" },
              { icon: SparkIcon, label: "Advice when you ask for it" },
              { icon: MuteIcon, label: "Silent the rest of the time" },
            ]}
          />
        </FadeInUp>
      </div>
    </section>
  );
}
