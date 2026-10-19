import { OG_SIZE, OgCard, renderOg } from "@/lib/og";
import catalog from "../../../../config/managed-catalog.json";

export const dynamic = "force-static";
export const alt = "Savvy pricing: free with your own providers, or managed from $29.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OpenGraphImage() {
  const { monthly, pack } = catalog;
  return renderOg({
    eyebrow: "Pricing",
    title: "Free with your own accounts.",
    subtitle: `Managed from $${pack.amountCents / 100}.`,
    visual: (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <OgCard
          tone="answer"
          title="Your own providers"
          say="$0, MIT-licensed"
          source="your transcription key + CLI"
        />
        <div style={{ display: "flex", marginLeft: -36 }}>
          <OgCard
            tone="answer"
            title="Savvy managed"
            say={`$${monthly.amountCents / 100} a month`}
            source={`${monthly.hours} meeting hours · ${monthly.briefs} briefs`}
          />
        </div>
      </div>
    ),
  });
}
