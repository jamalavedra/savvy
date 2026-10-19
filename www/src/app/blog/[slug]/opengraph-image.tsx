import { getAllPosts, getPost } from "@/lib/blog";
import { OG_SIZE, OgMascot, renderOg } from "@/lib/og";

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
  return renderOg({
    eyebrow: `Savvy blog · ${post?.readingMinutes ?? 1} min read`,
    title: post?.title ?? "Savvy blog",
    visual: <OgMascot state="listening" />,
  });
}
