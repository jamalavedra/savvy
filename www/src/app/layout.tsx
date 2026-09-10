import type { Metadata } from "next";
import { Analytics } from "@/components/Analytics";
import { SITE_URL } from "@/lib/constants";
import { caveat, inter, jetbrainsMono } from "@/lib/fonts";
import "./globals.css";

const TITLE = "Savvy | AI guidance from your documents, on your Mac";
const DESCRIPTION =
  "Prepare from your documents and get suggestions during conversations. Savvy is an open-source Mac app that shows guidance with supporting sources.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "meeting assistant",
    "AI meeting copilot",
    "real-time meeting assistant",
    "sales call assistant",
    "negotiation brief",
    "local-first",
    "macOS",
    "open source",
    "Claude Code",
    "Codex CLI",
  ],
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: "Savvy",
    type: "website",
    locale: "en_US",
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // The font variables live on <html>, not <body>: Tailwind's `@theme`
    // declares tokens like `--font-hand: var(--font-caveat), …` on :root, and
    // a var() nested inside a custom property is resolved where that property
    // is DECLARED. With the faces only on <body>, every such token resolved
    // against an undefined variable and the utility silently fell back to the
    // inherited family.
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} ${caveat.variable}`}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
