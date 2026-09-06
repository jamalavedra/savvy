import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/blog/Markdown";
import { Footer } from "@/components/layout/Footer";
import { Rail } from "@/components/layout/Rail";
import { TwoLineHeading } from "@/components/sections/primitives";
import { DownloadCTA } from "@/components/ui/DownloadCTA";
import { formatDate, getAllPosts, getPost } from "@/lib/blog";
import { COMPANY_NAME, REQUIREMENTS, SITE_URL } from "@/lib/constants";

type Params = { params: Promise<{ slug: string }> };

// Static export: every post is rendered at build time and unknown slugs 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  const url = `${SITE_URL}/blog/${slug}/`;
  return {
    title: `${post.title} — Savvy`,
    description: post.description,
    alternates: { canonical: `/blog/${slug}/` },
    openGraph: {
      title: post.title,
      description: post.description,
      url,
      type: "article",
      publishedTime: post.date,
      tags: post.tags,
    },
  };
}

export default async function BlogPost({ params }: Params) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();
  const url = `${SITE_URL}/blog/${slug}/`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        headline: post.title,
        description: post.description,
        datePublished: post.date,
        dateModified: post.date,
        keywords: post.tags.join(", "),
        inLanguage: "en",
        author: { "@type": "Organization", name: COMPANY_NAME },
        publisher: { "@type": "Organization", name: COMPANY_NAME },
        mainEntityOfPage: { "@type": "WebPage", "@id": url },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Savvy", item: `${SITE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/blog/` },
          { "@type": "ListItem", position: 3, name: post.title, item: url },
        ],
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD, no user input
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Rail active="/blog" />
      <main className="overflow-x-clip">
        <article className="py-16 lg:py-24">
          <div className="page-column">
            <div className="max-w-2xl">
              <Link
                href="/blog/"
                className="text-sm text-muted transition-colors hover:text-foreground"
              >
                ← Blog
              </Link>
              <p className="mt-8 font-mono text-[11px] uppercase tracking-wider text-muted">
                <time dateTime={post.date}>{formatDate(post.date)}</time>
                {" · "}
                {post.readingMinutes} min read
              </p>
              <TwoLineHeading as="h1" className="mt-3" line1={post.title} />
              <p className="mt-5 text-lg leading-relaxed text-muted">{post.description}</p>
              <div className="mt-10 text-[15px] leading-[1.75]">
                <Markdown body={post.body} />
              </div>
              <p className="mt-10 flex flex-wrap gap-2">
                {post.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-background-alt px-2.5 py-0.5 text-xs text-muted"
                  >
                    {tag}
                  </span>
                ))}
              </p>

              <aside className="mt-16 bg-background-alt px-6 py-8 sm:px-8">
                <h2 className="text-xl font-medium tracking-tight">Try it on your next call</h2>
                <p className="mt-3 text-sm leading-relaxed text-muted">
                  Savvy reads your own documents before the meeting, then listens alongside you and
                  says what to say, what to avoid, and which file says so. {REQUIREMENTS}.
                </p>
                <div className="mt-6 flex flex-wrap items-center gap-4">
                  <DownloadCTA />
                  <Link
                    href="/"
                    className="text-sm font-medium text-muted transition-colors hover:text-foreground"
                  >
                    See how it works →
                  </Link>
                </div>
              </aside>
            </div>
          </div>
        </article>
      </main>
      <Footer />
    </>
  );
}
