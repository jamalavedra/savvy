import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Wordmark } from "@/components/layout/Wordmark";
import { DownloadCTA } from "@/components/ui/DownloadCTA";
import { NAV, REPO_URL } from "@/lib/constants";

// money.x.com-style fixed left rail. Only shown on xl+, where the page-column
// utility reserves a 208px lane on the left for it; below that the regular
// top Header takes over.
export function Rail({ active = "/" }: { active?: string }) {
  return (
    <>
      <div className="hidden xl:block">
        <div className="fixed left-8 top-5 z-50">
          <Wordmark size={30} />
        </div>
        <nav
          aria-label="Site"
          className="fixed left-8 top-24 z-40 flex flex-col items-start gap-3.5 text-sm"
        >
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={
                item.href === active
                  ? "font-semibold"
                  : "text-muted transition-colors hover:text-foreground"
              }
            >
              {item.label}
            </Link>
          ))}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted transition-colors hover:text-foreground"
          >
            GitHub ↗
          </a>
        </nav>
        <div className="fixed bottom-8 left-8 z-40">
          <DownloadCTA size="sm" />
        </div>
      </div>
      <div className="xl:hidden">
        <Header />
      </div>
    </>
  );
}
