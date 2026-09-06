import type { Metadata } from "next";
import { SITE_URL } from "@/lib/constants";
import { inter, jetbrainsMono } from "@/lib/fonts";
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
    <html lang="en">
      <head>
        <script
          defer
          src="https://analytics.jamalavedra.com/script.js"
          data-website-id="8a7ddcdb-2cee-4719-a8f2-9c18aa8239e7"
          data-domains="savvycopilot.com"
        />
      </head>
      <body className={`${inter.variable} ${jetbrainsMono.variable}`}>{children}</body>
    </html>
  );
}
