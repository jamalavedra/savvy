import type { CSSProperties, ReactNode } from "react";
import { FadeInUp } from "@/components/animations/FadeInUp";
import {
  CHECK_PATH,
  Eyebrow,
  StatList,
  TerminalIcon,
  TwoLineHeading,
  UserIcon,
  WaveIcon,
} from "@/components/sections/primitives";
import "./providers.css";

// Full-precision path. Rounding these coordinates to 1dp collapses the burst
// into a lopsided blob — the deltas are relative, so the error accumulates.
function ClaudeMark() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

function OpenAIMark() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
      <path d="M22.28 9.82a5.99 5.99 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.99 5.99 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07Zm-9.02 12.6a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5Zm-9.66-4.13a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65ZM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97V11.6a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.9Zm16.6 3.86-5.83-3.39L15.12 7.2a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.4-.65Zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66ZM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.79.79 0 0 0-.39.68l-.01 6.72Zm1.1-2.36 2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5v-3Z" />
    </svg>
  );
}

function SpeechMark() {
  return (
    <svg
      viewBox="0 0 26 26"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 10v6M9 6.5v13M13 3.5v19M17 6.5v13M22 10v6" />
    </svg>
  );
}

const CheckBadge = (
  <span className="pr-check absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-success text-white shadow-sm">
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={CHECK_PATH} />
    </svg>
  </span>
);

// Each mark takes a third of the 9s loop.
const MARKS: { key: string; mark: ReactNode }[] = [
  { key: "claude", mark: <ClaudeMark /> },
  { key: "openai", mark: <OpenAIMark /> },
  { key: "speech", mark: <SpeechMark /> },
];

const ProvidersVignette = (
  <div className="relative flex flex-col items-center pt-[104px] pb-2">
    <div className="pr-seat relative grid h-[64px] w-[184px] place-items-center rounded-2xl border border-accent-soft bg-surface shadow-sm">
      <span
        aria-hidden="true"
        className="pr-ring absolute inset-0 rounded-2xl border border-accent"
      />
      <span className="savvy-wordmark text-[24px]">savvy</span>
    </div>

    <div className="absolute left-1/2 top-[62px] grid h-[54px] w-[54px] -translate-x-1/2 *:col-start-1 *:row-start-1">
      {MARKS.map(({ key, mark }, i) => (
        <span
          key={key}
          className="pr-drop relative grid place-items-center rounded-xl border border-border bg-surface text-foreground shadow-sm"
          style={{ "--pr-delay": `${i * 3}s` } as CSSProperties}
        >
          {mark}
          {CheckBadge}
        </span>
      ))}
    </div>

    <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
      Already on your Mac
    </p>
  </div>
);

export function YourModel() {
  return (
    <section className="py-20 lg:py-28">
      <div className="page-column grid gap-10 *:min-w-0 lg:grid-cols-[1fr_minmax(0,380px)_1fr] lg:gap-12">
        <FadeInUp>
          <Eyebrow>Bring your own</Eyebrow>
          <TwoLineHeading
            className="mt-4"
            line1="Use your own accounts"
            line2="Choose your providers"
          />
        </FadeInUp>

        <FadeInUp delay={0.1}>
          <div
            className="panel relative overflow-hidden px-4 pb-6"
            style={{ "--hue": "var(--color-hue-pink)" } as CSSProperties}
          >
            {ProvidersVignette}
          </div>
        </FadeInUp>

        <FadeInUp delay={0.15}>
          <p className="text-sm leading-relaxed text-muted">
            The open-source app uses Claude Code or Codex CLI for guidance. Sign in on your Mac and
            use your existing provider account. Savvy sends selected excerpts, the whole brief, and
            recent transcript turns to that provider.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Transcription uses your Deepgram or AssemblyAI API key, stored in the macOS Keychain.
            Your providers bill for usage.
          </p>
          <StatList
            items={[
              { icon: TerminalIcon, label: "Claude Code or Codex CLI" },
              { icon: UserIcon, label: "Your account and its terms" },
              { icon: WaveIcon, label: "Deepgram or AssemblyAI, your key" },
            ]}
          />
        </FadeInUp>
      </div>
    </section>
  );
}
