import fs from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";
import type { ReactNode } from "react";

// Shared frame for the social preview images (homepage, pricing, each post).
// Satori needs real font files, so Nunito and Plex Mono are vendored as TTF.

export const OG_SIZE = { width: 1200, height: 630 };

export const C = {
  bg: "#fafaf7",
  surface: "#ffffff",
  fg: "#1a1a1a",
  muted: "#77736e",
  border: "#e0ddd6",
  inset: "#f6f5f2",
  pink: "#f9a3ab",
  pinkLight: "#fde1e4",
  pinkDeep: "#c9636f",
  success: "#1f7a35",
  danger: "#b4380a",
};

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p));

const fonts = () => [
  { name: "Nunito", data: read("src/assets/fonts/Nunito-700.ttf"), weight: 700 as const },
  { name: "Nunito", data: read("src/assets/fonts/Nunito-800.ttf"), weight: 800 as const },
  { name: "Plex Mono", data: read("src/assets/fonts/IBMPlexMono-500.ttf"), weight: 500 as const },
];

/** A recommendation card as it appears in the app overlay. */
export function OgCard({
  title,
  say,
  source,
  grounded,
  tone,
}: {
  title: string;
  say: string;
  source: string;
  grounded?: number;
  tone: "answer" | "redline";
}) {
  const accent = tone === "answer" ? C.success : C.danger;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: 440,
        padding: 22,
        borderRadius: 20,
        background: C.surface,
        border: `1px solid ${C.border}`,
        boxShadow: "0 18px 40px -18px rgba(0,0,0,0.25)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div
          style={{
            display: "flex",
            fontSize: 18,
            color: accent,
            background: tone === "answer" ? "#e7f2e9" : "#fbe9e3",
            padding: "4px 12px",
            borderRadius: 999,
          }}
        >
          {title}
        </div>
        {grounded !== undefined && (
          <div style={{ display: "flex", fontFamily: "Plex Mono", fontSize: 18, color: C.muted }}>
            {`${grounded}%`}
          </div>
        )}
      </div>
      <div style={{ display: "flex", marginTop: 14, fontSize: 28, color: C.fg }}>{say}</div>
      <div
        style={{
          display: "flex",
          marginTop: 14,
          padding: "8px 12px",
          borderRadius: 10,
          background: C.inset,
          fontFamily: "Plex Mono",
          fontSize: 17,
          color: C.muted,
        }}
      >
        {source}
      </div>
    </div>
  );
}

export function renderOg({
  eyebrow,
  title,
  subtitle,
  visual,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  visual: ReactNode;
}) {
  const titleSize = title.length > 60 ? 50 : title.length > 36 ? 54 : 66;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: C.bg,
        fontFamily: "Nunito",
        fontWeight: 700,
        padding: "64px 64px 56px",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", flex: 1, paddingRight: 40 }}>
        <div
          style={{
            display: "flex",
            fontSize: 44,
            fontWeight: 800,
            color: C.pink,
            letterSpacing: "-0.07em",
            textShadow: `0 3px 0 ${C.pinkDeep}`,
          }}
        >
          savvy
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 44,
            fontFamily: "Plex Mono",
            fontSize: 18,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: C.muted,
          }}
        >
          {eyebrow}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 16,
            fontSize: titleSize,
            fontWeight: 800,
            lineHeight: 1.08,
            letterSpacing: "-0.03em",
            color: C.fg,
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div style={{ display: "flex", marginTop: 20, fontSize: 28, color: C.muted }}>
            {subtitle}
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-end",
          width: 460,
        }}
      >
        {visual}
      </div>
    </div>,
    { ...OG_SIZE, fonts: fonts() },
  );
}
