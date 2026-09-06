export const SITE_NAME = "Savvy";
export const COMPANY_NAME = "Alamas Labs";
// TODO: swap for the real domain before the first deploy. Used for canonical
// URLs, Open Graph and the sitemap.
export const SITE_URL = "https://jamalavedra.github.io/savvy";

export const REPO_URL = "https://github.com/jamalavedra/savvy";

export const LINKS = {
  download: `${REPO_URL}/releases/latest`,
  releases: `${REPO_URL}/releases`,
  issues: `${REPO_URL}/issues`,
  contributing: `${REPO_URL}/blob/main/CONTRIBUTING.md`,
  security: `${REPO_URL}/blob/main/SECURITY.md`,
  license: `${REPO_URL}/blob/main/LICENSE`,
  readme: `${REPO_URL}#readme`,
} as const;

/** Section anchors shared by the rail, the header menu and the footer. */
export const NAV = [
  { label: "Overview", href: "/" },
  { label: "How it works", href: "/#how" },
  { label: "Features", href: "/#features" },
  { label: "Privacy", href: "/#privacy" },
  { label: "FAQ", href: "/#faq" },
] as const;

export const REQUIREMENTS = "macOS 13+ · Apple Silicon · Free, MIT-licensed";
