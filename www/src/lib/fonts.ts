import { Caveat, IBM_Plex_Mono, Nunito } from "next/font/google";

// Rounded sans for everything; SF Pro Rounded wins on Apple devices (see
// --font-sans). The mono is for figures, file paths and timers only.
export const nunito = Nunito({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-nunito",
  display: "swap",
});

export const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

// Handwriting for the blog's hand-drawn figures only, never the product UI.
export const caveat = Caveat({
  subsets: ["latin"],
  weight: ["600"],
  variable: "--font-hand",
  display: "swap",
});
