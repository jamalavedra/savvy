import Image from "next/image";
import { Divider } from "@/components/sections/primitives";
import { COMPANY_NAME, LINKS, NAV, REPO_URL } from "@/lib/constants";
import "./footer.css";

type FooterLink = { label: string; href: string; external?: boolean };

const COLUMNS: { heading: string; links: FooterLink[] }[] = [
  {
    heading: "Savvy",
    links: NAV.map((item) => ({ label: item.label, href: item.href })),
  },
  {
    heading: "Project",
    links: [
      { label: "GitHub", href: REPO_URL, external: true },
      { label: "Latest release", href: LINKS.download, external: true },
      { label: "All releases", href: LINKS.releases, external: true },
      { label: "Contributing", href: LINKS.contributing, external: true },
      { label: "Security policy", href: LINKS.security, external: true },
      { label: "MIT license", href: LINKS.license, external: true },
    ],
  },
  {
    heading: "Support",
    links: [
      { label: "Privacy policy", href: "/privacy/" },
      { label: "Report an issue", href: LINKS.issues, external: true },
      { label: "README", href: LINKS.readme, external: true },
    ],
  },
];

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer>
      <Divider />

      <div className="page-column pt-16 pb-12">
        <div className="grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {COLUMNS.map((column) => (
            <div key={column.heading}>
              <h2 className="text-sm font-medium">{column.heading}</h2>
              <ul className="mt-4 space-y-3">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="text-sm text-muted transition-colors hover:text-foreground"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-14 text-xs text-muted">
          © {year} {COMPANY_NAME}
        </p>
      </div>
      <div aria-hidden className="ft-flourish">
        <div className="ft-cat">
          <Image
            className="ft-cat-listening"
            src="/images/mascot/savvy-listening.png"
            alt=""
            width={192}
            height={192}
          />
          <Image
            className="ft-cat-thinking"
            src="/images/mascot/savvy-thinking.png"
            alt=""
            width={192}
            height={192}
          />
        </div>
        <p className="ft-mark">
          <span className="savvy-wordmark">savvy</span>
        </p>
      </div>
    </footer>
  );
}
