import { OG_SIZE, OgCard, renderOg } from "@/lib/og";

export const dynamic = "force-static";
export const alt =
  "Savvy: a real-time AI meeting assistant for Mac. Cards say what to say and which file says so.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OpenGraphImage() {
  return renderOg({
    eyebrow: "AI meeting assistant · Mac · No bot",
    title: "Know what to say, and which file says so.",
    subtitle: "Free and open source.",
    visual: (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <OgCard
          tone="answer"
          title="Answer"
          say="Net-60, not net-90."
          source="payment-terms.pdf · p.2"
          grounded={94}
        />
        <div style={{ display: "flex", marginLeft: -36 }}>
          <OgCard
            tone="redline"
            title="Red line"
            say="Discount stays under 15%."
            source="brief · Red lines"
            grounded={100}
          />
        </div>
      </div>
    ),
  });
}
