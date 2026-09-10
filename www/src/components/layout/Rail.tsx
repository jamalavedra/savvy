import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Wordmark } from "@/components/layout/Wordmark";
import { DownloadCTA, GitHubCTA } from "@/components/ui/DownloadCTA";
import { NAV } from "@/lib/constants";

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
        </nav>
        <div className="fixed bottom-8 left-8 z-40 flex flex-col items-start gap-2.5">
          <DownloadCTA size="sm" />
          <GitHubCTA />
        </div>
      </div>
      <div className="xl:hidden">
        <Header />
      </div>
    </>
  );
}
