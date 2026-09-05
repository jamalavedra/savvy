import { LINKS } from "@/lib/constants";

export function AppleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 18 18" fill="currentColor">
      <path d="M14.94 13.5a8.86 8.86 0 0 1-.87 1.58c-.46.65-.83 1.1-1.12 1.35-.45.41-.93.62-1.44.63-.37 0-.81-.1-1.33-.32-.52-.21-.99-.31-1.43-.31-.46 0-.95.1-1.48.31-.53.22-.96.33-1.29.34-.49.02-.98-.2-1.47-.65-.31-.27-.7-.74-1.17-1.4-.5-.71-.91-1.54-1.23-2.48C1.71 11.33 1.5 10.22 1.5 9.14c0-1.23.27-2.29.8-3.17a4.67 4.67 0 0 1 1.65-1.69A4.44 4.44 0 0 1 6.17 3.5c.39 0 .9.12 1.54.35.63.24 1.04.36 1.22.36.13 0 .58-.14 1.33-.42.71-.26 1.31-.37 1.8-.33 1.33.11 2.33.63 2.99 1.58-1.19.72-1.78 1.73-1.77 3.03.01 1.01.38 1.85 1.1 2.52.33.31.69.55 1.1.72-.09.26-.18.5-.28.75l-.26-.06ZM11.37 1.3c0 .79-.29 1.53-.86 2.21-.7.81-1.53 1.28-2.44 1.21a2.46 2.46 0 0 1-.02-.3c0-.76.33-1.57.92-2.24.3-.34.67-.62 1.13-.84.46-.22.89-.34 1.3-.37.01.11.02.22.02.33h-.05Z" />
    </svg>
  );
}

/** "Download for Mac" pill → latest GitHub release (DMG, Apple Silicon). */
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
