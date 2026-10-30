import { COVER_SIZE, type PostArt, TONES } from "@/content/blog-art/types";

/** The post's cover on its art-panel ground; the art itself is fixed-size, so it scales by zoom. */
export function Cover({ art, compact = false }: { art: PostArt; compact?: boolean }) {
  return (
    <div
      className={`art-panel flex items-center justify-center overflow-hidden ${
        compact ? "aspect-[16/10] min-h-[248px]" : "py-8 sm:py-12"
      }`}
      style={{ background: TONES[art.tone] }}
    >
      <div className={compact ? "cover-zoom-sm" : "cover-zoom"} style={COVER_SIZE}>
        {art.cover}
      </div>
    </div>
  );
}
