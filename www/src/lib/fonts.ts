import { Inter, JetBrains_Mono } from "next/font/google";

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
