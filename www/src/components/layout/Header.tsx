import Link from "next/link";
import { Wordmark } from "@/components/layout/Wordmark";
import { DownloadCTA } from "@/components/ui/DownloadCTA";
import { NAV } from "@/lib/constants";

// Top bar for viewports without the fixed left rail (below xl).
export function Header() {
  return (
    <header className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="flex items-center gap-6">
        <Wordmark size={26} />
        <nav aria-label="Site" className="hidden items-center gap-5 text-sm md:flex">
          {NAV.slice(1).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-muted transition-colors hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      <DownloadCTA size="sm" />
    </header>
  );
}
