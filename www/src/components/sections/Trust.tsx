import { FadeInUp } from "@/components/animations/FadeInUp";
import { FolderIcon, KeyIcon, MuteIcon, TerminalIcon } from "@/components/sections/primitives";
import { GitHubCTA } from "@/components/ui/DownloadCTA";
import { REQUIREMENTS } from "@/lib/constants";

const PROOFS = [
  {
    icon: MuteIcon,
    title: "No bot in your call.",
    body: "Nothing joins the participant list. Savvy listens on your Mac.",
  },
  {
    icon: FolderIcon,
    title: "Your files stay put.",
    body: "Indexed in a local database. Your AI provider gets selected excerpts, not whole files.",
  },
  {
    icon: KeyIcon,
    title: "Your keys, your models.",
    body: "Claude Code or Codex CLI on your own account, keys in the Keychain. Or use Savvy managed.",
  },
  {
    icon: TerminalIcon,
    title: "Every line is public.",
    body: "MIT-licensed. The source is on GitHub.",
  },
];

export function Trust() {
  return (
    <section className="pb-20 lg:pb-28">
      <div className="page-column">
        <FadeInUp>
          <div className="rounded-[22px] bg-foreground px-6 py-10 text-background sm:px-10 lg:px-14 lg:py-14">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <h2 className="text-title max-w-md text-balance">
                Trust it because you can check it.
              </h2>
              <p className="text-small text-white/70">{REQUIREMENTS}</p>
            </div>
            <ul className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {PROOFS.map((p) => (
                <li key={p.title} className="border-t border-white/15 pt-5">
                  <span className="text-white/70">{p.icon}</span>
                  <p className="mt-3 text-body font-semibold">{p.title}</p>
                  <p className="mt-1 text-small text-white/70">{p.body}</p>
                </li>
              ))}
            </ul>
            <div className="mt-10 [&_a]:border-white/25 [&_a]:text-background">
              <GitHubCTA />
            </div>
          </div>
        </FadeInUp>
      </div>
    </section>
  );
}
