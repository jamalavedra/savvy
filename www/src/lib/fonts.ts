import { Caveat, Inter, JetBrains_Mono } from "next/font/google";

// Inter is the app's UI face (savvy/src/App.css); the mono is for eyebrows,
// file paths and numerals only.
export const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

// The one hand-annotation voice: the margin note beside the hero, nothing else.
export const caveat = Caveat({
  subsets: ["latin"],
  variable: "--font-caveat",
  display: "swap",
});
