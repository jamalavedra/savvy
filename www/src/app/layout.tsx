import type { Metadata } from "next";
import { SITE_URL } from "@/lib/constants";
import { inter, jetbrainsMono } from "@/lib/fonts";
import "./globals.css";

const TITLE = "Savvy — Source-grounded live guidance for meetings, on your Mac";
const DESCRIPTION =
  "Savvy reads your documents before the meeting, then listens alongside you and whispers what to say, what to avoid, and which file says so. Local-first macOS meeting assistant, open source.";

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
      <body className={`${inter.variable} ${jetbrainsMono.variable}`}>{children}</body>
    </html>
  );
}
