import { getArt } from "@/content/blog-art";
import { COVER_SIZE, TONES } from "@/content/blog-art/types";
import { getAllPosts, getPost } from "@/lib/blog";
import { OG_SIZE, renderOg } from "@/lib/og";

export const dynamic = "force-static";
export const alt = "A post from the Savvy blog.";
export const size = OG_SIZE;
export const contentType = "image/png";

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPost(slug);
  const art = getArt(slug);
  return renderOg({
    eyebrow: `Savvy blog · ${post?.readingMinutes ?? 1} min read`,
    title: post?.title ?? "Savvy blog",
    visual: (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 460,
          height: 500,
          borderRadius: 22,
          backgroundImage: TONES[art.tone],
        }}
      >
        <div style={{ display: "flex", ...COVER_SIZE }}>{art.cover}</div>
      </div>
    ),
  });
}
