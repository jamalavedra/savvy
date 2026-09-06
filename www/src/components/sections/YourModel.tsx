import { FadeInUp } from "@/components/animations/FadeInUp";
import {
  Eyebrow,
  StatList,
  TerminalIcon,
  TwoLineHeading,
  UserIcon,
  WaveIcon,
} from "@/components/sections/primitives";
import { ProviderChip } from "@/components/sections/vignettes";

// Savvy has no model of its own — it shells out to the CLI already signed in
// on the Mac. This is the pricing objection answered before it is asked, so it
// gets the full three-column treatment with the provider-check chip on top.

function ClaudeMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="m4.7 15.3 4.6-2.6.1-.2-.1-.1H9l-.9-.1-3-.1-2.6-.1-2.5-.1-.7-.2L0 11l.1-.4.5-.4.8.1 1.7.1 2.6.2 1.9.1 2.8.3h.4l.1-.2-.2-.1-.1-.1-2.7-1.8L4.9 6.9l-1.5-1.1-.8-.6-.4-.5-.2-1.2.8-.8 1 .1.3.1 1 .8L7.3 5.3l2.8 2 .4.4.2-.1v-.1L10.3 6 9 3.6l-.7-1.1-.2-.7c-.1-.3-.1-.5-.1-.8L9 0l.5-.2 1.2.2.5.4.8 1.8 1.2 2.7.7 1.4.2.5.1-.4.2-1.8.3-2.2.3-.8.2-.6.6-.7 1.1.1.6 1.3-.1.5-.8 2.6-.6 2.9.2.1.1-.1L16.5 7.6l1.9-2.4 1.5-1.7.6-.5.9-.2.6.9-.3 1.1-1.3 1.6-1.1 1.4-1.5 2v.2h.3l2.4-.5 2.7-.5 1.7-.1.7.3.1.7-.3.7-1.9.5-2.2.4-3.2.8-.1.1v.1l1.5.1 1.1.1h2.6l1.9.1.5.4.3.4-.1.3-.8.4-1-.2-2.4-.6-.8-.2h-.1v.1l.7.7 1.3 1.1 1.6 1.4.1.4-.2.3-.2-.1-1.5-1.1-.6-.5-1.2-1h-.1v.2l.3.4 1.5 2.2.1.7-.1.2-.4.1-.4-.1-.9-1.2-.9-1.4-.7-1.2-.1.1-.4 4.4-.2.2-.4.2-.4-.3-.2-.5.2-1 .2-1.3.2-1 .2-1.3.1-.4v-.1l-.4.5-.8 1.1-1.4 1.6-1 .7-.6-.3v-.6l.3-.5 1.8-2.3.8-1 .3-.5v-.2h-.1L3.7 17l-.7-.3v-.4l.7-.5.5-.5Z" />
    </svg>
  );
}

function OpenAIMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M22.28 9.82a5.99 5.99 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.99 5.99 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07Zm-9.02 12.6a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5Zm-9.66-4.13a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65ZM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97V11.6a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.9Zm16.6 3.86-5.83-3.39L15.12 7.2a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.4-.65Zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66ZM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.79.79 0 0 0-.39.68l-.01 6.72Zm1.1-2.36 2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5v-3Z" />
    </svg>
  );
}

function ProviderRow({
  mark,
  name,
  detail,
  ready,
  active,
}: {
  mark: React.ReactNode;
  name: string;
  detail: string;
  ready: boolean;
  active?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-3.5 py-3 ${active ? "bg-[var(--accent-pale)]" : ""}`}
    >
      <span className="relative grid h-8 w-8 flex-none place-items-center rounded-lg bg-[var(--background-ui)] text-[var(--text)]">
        {mark}
        <span className={`provider-status-dot ${ready ? "ready" : ""}`} />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <strong className="text-[13px]">{name}</strong>
        <small className="truncate text-[11px] text-[var(--muted)]">{detail}</small>
      </span>
      {active && (
        <span className="flex-none rounded-full bg-[var(--text)] px-2 py-0.5 text-[10px] font-semibold text-[var(--background)]">
          In use
        </span>
      )}
    </div>
  );
}

// The Settings › Models card: two providers with status dots and the model
// picker, plus a floating check chip that resolves on hover, like the app's
// provider health probe does after a fresh install.
const ProvidersVignette = (
  <div className="relative w-full">
    <ProviderChip />
    <div className="sv mx-auto mt-20 w-full max-w-[340px]">
      <div className="prepare-card divide-y divide-[var(--border-soft)] shadow-sm">
        <div className="px-3.5 pb-1 pt-3 font-mono text-[10px] uppercase tracking-wider text-[var(--muted)]">
          Recommendations
        </div>
        <ProviderRow
          mark={<ClaudeMark />}
          name="Claude Code"
          detail="claude-fable-5 · 1M context"
          ready
          active
        />
        <ProviderRow
          mark={<OpenAIMark />}
          name="Codex CLI"
          detail="gpt-5.6-sol · priority tier"
          ready={false}
        />
        <div className="px-3.5 pb-1 pt-3 font-mono text-[10px] uppercase tracking-wider text-[var(--muted)]">
          Transcription
        </div>
        <ProviderRow
          mark={<span className="font-mono text-[11px] font-bold">DG</span>}
          name="Deepgram"
          detail="nova-3 · key in Keychain · mip_opt_out=true"
          ready
          active
        />
      </div>
    </div>
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
            line1="The CLI you already have"
            line2="No subscription, no markup"
          />
        </FadeInUp>

        <FadeInUp delay={0.1}>
          <div className="relative overflow-hidden bg-background-alt px-4 pb-6">
            {ProvidersVignette}
          </div>
        </FadeInUp>

        <FadeInUp delay={0.15}>
          <p className="text-sm leading-relaxed text-muted">
            Savvy doesn't run a model of its own. It shells out to Claude Code or the Codex CLI
            already signed in on your Mac, so recommendations bill to the plan you have and follow
            the terms you agreed to. Excerpts and recent turns go to that provider under your
            account, nowhere else.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Speech goes through your own Deepgram or AssemblyAI key, stored in the macOS Keychain,
            with model-training opt-out set where the provider offers it.
          </p>
          <StatList
            items={[
              { icon: TerminalIcon, label: "Claude Code or Codex CLI" },
              { icon: UserIcon, label: "Your account, your limits, your terms" },
              { icon: WaveIcon, label: "Deepgram or AssemblyAI, your key" },
            ]}
          />
        </FadeInUp>
      </div>
    </section>
  );
}
