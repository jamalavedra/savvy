import type { Metadata } from "next";
import { Analytics } from "@/components/Analytics";
import { SITE_URL } from "@/lib/constants";
import { caveat, inter, jetbrainsMono } from "@/lib/fonts";
import "./globals.css";

const TITLE = "Savvy | AI meeting assistant for Mac, no bot in the call";
const DESCRIPTION =
  "Savvy is a free, open-source AI meeting assistant for Mac. Nothing joins the call: it prepares a brief from your own documents, then shows real-time guidance during the conversation, with the file behind every suggestion.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "AI meeting assistant",
    "AI note taker",
    "real-time meeting assistant",
    "meeting assistant without a bot",
    "AI meeting assistant for Mac",
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
    // Tailwind resolves font tokens on :root, so the font variables belong on <html>.
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} ${caveat.variable}`}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
