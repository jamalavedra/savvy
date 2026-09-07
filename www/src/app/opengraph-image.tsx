import fs from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";

export const dynamic = "force-static";
export const alt = "Savvy: AI guidance from your documents, on your Mac.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  const mascot = fs.readFileSync(
    path.join(process.cwd(), "public/images/mascot/savvy-thinking.png"),
  );
  const mascotSrc = `data:image/png;base64,${mascot.toString("base64")}`;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 48,
        background: "#fbfbfb",
        padding: "72px 64px",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          height: "100%",
          flex: 1,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", flexDirection: "column", color: "#0f0f0f" }}>
            <div style={{ fontSize: 70, fontWeight: 700, letterSpacing: "-0.035em" }}>
              Your notes,
            </div>
            <div
              style={{
                fontSize: 70,
                fontWeight: 700,
                letterSpacing: "-0.035em",
                color: "#77736e",
              }}
            >
              when you need them.
            </div>
          </div>
          <div style={{ display: "flex", marginTop: 28, fontSize: 30, color: "#77736e" }}>
            AI guidance from your documents, on your Mac.
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 44, fontWeight: 700, color: "#f9a3ab" }}>
          savvy
        </div>
      </div>
      <div
        style={{
          display: "flex",
          // The mascot art is a bust cropped at the frame edge, so it is bottom-aligned
          // and clipped by the circle — otherwise the flat cut shows against the pink.
          alignItems: "flex-end",
          justifyContent: "center",
          flexShrink: 0,
          width: 400,
          height: 400,
          borderRadius: 200,
          overflow: "hidden",
          background: "#fde1e4",
        }}
      >
        {/* biome-ignore lint/performance/noImgElement: Satori renders plain <img>, next/image is unavailable here. */}
        <img src={mascotSrc} alt="" width={380} height={380} />
      </div>
    </div>,
    size,
  );
}
