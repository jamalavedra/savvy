import { LINKS, REPO_URL } from "@/lib/constants";

function AppleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 18 18" fill="currentColor">
      <path d="M14.94 13.5a8.86 8.86 0 0 1-.87 1.58c-.46.65-.83 1.1-1.12 1.35-.45.41-.93.62-1.44.63-.37 0-.81-.1-1.33-.32-.52-.21-.99-.31-1.43-.31-.46 0-.95.1-1.48.31-.53.22-.96.33-1.29.34-.49.02-.98-.2-1.47-.65-.31-.27-.7-.74-1.17-1.4-.5-.71-.91-1.54-1.23-2.48C1.71 11.33 1.5 10.22 1.5 9.14c0-1.23.27-2.29.8-3.17a4.67 4.67 0 0 1 1.65-1.69A4.44 4.44 0 0 1 6.17 3.5c.39 0 .9.12 1.54.35.63.24 1.04.36 1.22.36.13 0 .58-.14 1.33-.42.71-.26 1.31-.37 1.8-.33 1.33.11 2.33.63 2.99 1.58-1.19.72-1.78 1.73-1.77 3.03.01 1.01.38 1.85 1.1 2.52.33.31.69.55 1.1.72-.09.26-.18.5-.28.75l-.26-.06ZM11.37 1.3c0 .79-.29 1.53-.86 2.21-.7.81-1.53 1.28-2.44 1.21a2.46 2.46 0 0 1-.02-.3c0-.76.33-1.57.92-2.24.3-.34.67-.62 1.13-.84.46-.22.89-.34 1.3-.37.01.11.02.22.02.33h-.05Z" />
    </svg>
  );
}

export function DownloadCTA({ size = "md" }: { size?: "md" | "sm" }) {
  return (
    <a
      href={LINKS.download}
      target="_blank"
      rel="noopener noreferrer"
      className={`focus-ring inline-flex items-center justify-center gap-2 rounded-full bg-foreground font-semibold text-background transition-opacity duration-200 hover:opacity-80 ${
        size === "sm" ? "px-4 py-2 text-[13px]" : "px-5 py-2.5 text-sm"
      }`}
    >
      <AppleIcon size={size === "sm" ? 12 : 14} />
      Download for Mac
    </a>
  );
}

export function WindowsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 18 18" fill="currentColor">
      <path d="M0 2.55 7.35 1.55v6.9H0V2.55ZM8.25 1.42 18 0v8.45H8.25V1.42ZM0 9.55h7.35v6.9L0 15.45v-5.9ZM8.25 9.55H18V18l-9.75-1.42V9.55Z" />
    </svg>
  );
}

/**
 * Windows is being built (jamalavedra/savvy#15) but there is nothing to
 * download yet, so this is a genuinely disabled control rather than a link
 * that goes nowhere — screen readers get told, and nothing is clickable.
 */
export function WindowsSoon({ size = "md" }: { size?: "md" | "sm" }) {
  return (
    <button
      type="button"
      disabled
      className={`inline-flex cursor-not-allowed items-center justify-center gap-2 rounded-full border border-border font-semibold text-muted ${
        size === "sm" ? "px-4 py-2 text-[13px]" : "px-5 py-2.5 text-sm"
      }`}
    >
      <WindowsIcon size={size === "sm" ? 12 : 14} />
      Windows — coming soon
    </button>
  );
}

export function GitHubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

/** The repo, as a button — it lives in the rail rather than the hero, where
 *  it competed with the download. */
export function GitHubCTA() {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="focus-ring inline-flex items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-[13px] font-semibold transition-colors hover:bg-background-alt"
    >
      <GitHubIcon size={12} />
      View on GitHub
    </a>
  );
}
