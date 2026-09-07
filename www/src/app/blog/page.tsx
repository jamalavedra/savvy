import type { Metadata } from "next";
import Link from "next/link";
import { FadeInUp } from "@/components/animations/FadeInUp";
import { Footer } from "@/components/layout/Footer";
import { Rail } from "@/components/layout/Rail";
import { TwoLineHeading } from "@/components/sections/primitives";
import { formatDate, getAllPosts } from "@/lib/blog";
import { COMPANY_NAME, SITE_URL } from "@/lib/constants";

const TITLE = "Blog | Savvy";
const DESCRIPTION =
  "Notes on preparing for calls, meeting-recording consent, local-first meeting assistants, and how Savvy decides when to speak.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/blog/" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${SITE_URL}/blog/`,
    type: "website",
  },
};

export default function BlogIndex() {
  const posts = getAllPosts();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: "Savvy blog",
    url: `${SITE_URL}/blog/`,
    description: DESCRIPTION,
    publisher: { "@type": "Organization", name: COMPANY_NAME },
    blogPost: posts.map((post) => ({
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      datePublished: post.date,
      url: `${SITE_URL}/blog/${post.slug}/`,
    })),
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
        <section className="py-20 lg:py-28">
          <div className="page-column">
            <FadeInUp>
              <TwoLineHeading as="h1" line1="Blog" line2="Notes from building Savvy" />
            </FadeInUp>
            <FadeInUp delay={0.1}>
              <ul className="mt-14 max-w-2xl divide-y divide-border border-y border-border">
                {posts.map((post) => (
                  <li key={post.slug}>
                    <Link href={`/blog/${post.slug}/`} className="group block py-7">
                      <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
                        <time dateTime={post.date}>{formatDate(post.date)}</time>
                        {" · "}
                        {post.readingMinutes} min read
                      </p>
                      <h2 className="mt-2 text-lg font-medium leading-snug tracking-tight transition-colors group-hover:text-foreground/70">
                        {post.title}
                      </h2>
                      <p className="mt-2 text-sm leading-relaxed text-muted">{post.description}</p>
                      <p className="mt-3 flex flex-wrap gap-2">
                        {post.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-background-alt px-2.5 py-0.5 text-xs text-muted"
                          >
                            {tag}
                          </span>
                        ))}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            </FadeInUp>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
