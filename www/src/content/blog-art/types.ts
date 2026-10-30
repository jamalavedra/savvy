import type { ReactNode } from "react";

/** Art-panel grounds, shared by the page cover, the index card and the OG image. */
export const TONES = {
  dusk: "radial-gradient(120% 100% at 85% 0, #8a96ff 0%, #2f3f96 45%, #0d1230 100%)",
  paper: "radial-gradient(120% 95% at 80% 0, #fbf3e6 0%, #e6c9a6 40%, #6a4628 100%)",
  moss: "radial-gradient(120% 100% at 85% 0, #a6e8c6 0%, #23785a 45%, #071d17 100%)",
  ember: "radial-gradient(110% 90% at 15% 0, #ffb27a 0%, #f44700 42%, #4a1806 100%)",
  night: "radial-gradient(120% 100% at 15% 0, #b48cff 0%, #4b2d8f 45%, #120b26 100%)",
} as const;

export type PostArt = {
  tone: keyof typeof TONES;
  /**
   * Flat cover drawn at COVER_SIZE. It is also rendered by Satori for the OG
   * image, so: inline styles only, every element display:flex, px units, no SVG
   * text, no classes. Leave fontFamily unset for the sans (it inherits Nunito);
   * use fontFamily: MONO for figures, file names and timers.
   */
  cover: ReactNode;
  /** Optional hand-drawn figure, placed where the post has a `{{figure}}` line. */
  figure?: ReactNode;
};

export const COVER_SIZE = { width: 440, height: 400 };

/** Resolves to Plex Mono in Satori and the system mono on the page. */
export const MONO = "Plex Mono, ui-monospace, monospace";
