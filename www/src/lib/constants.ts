export const COMPANY_NAME = "Alamas Labs";
export const SITE_URL = "https://www.savvycopilot.com";

export const REPO_URL = "https://github.com/jamalavedra/savvy";

// shortcut: asset names carry the version, so bump this on each release (or switch to unversioned asset names).
export const RELEASE_VERSION = "0.1.5";
const ASSETS = `${REPO_URL}/releases/download/v${RELEASE_VERSION}`;

export const LINKS = {
  download: `${REPO_URL}/releases/latest`,
  downloadMac: `${ASSETS}/Savvy_${RELEASE_VERSION}_aarch64.dmg`,
  downloadWindows: `${ASSETS}/Savvy_${RELEASE_VERSION}_x64-setup.exe`,
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
  { label: "Pricing", href: "/pricing/" },
  { label: "Blog", href: "/blog" },
  { label: "FAQ", href: "/#faq" },
] as const;

export const REQUIREMENTS = "macOS 13+ (Apple Silicon) · Windows 10+ · Free, MIT-licensed";
