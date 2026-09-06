# Blog and SEO layer

## What caretta.so and parakeet-ai.com do that we did not (research, 2026-09-06)

Fetched both homepages, blogs, sitemaps, `llms.txt`, and three Caretta posts; raw HTML grepped for JSON-LD and meta tags.

- **Both run bottom-of-funnel comparison content.** Parakeet has a `/compare` hub plus five `parakeet-ai-vs-<competitor>` pages in its sitemap; its blog is almost entirely "Best <tool> alternatives" listicles. Caretta writes category-vs-category ("Conversation intelligence vs real-time call guidance") and "best X by use case" pieces that name competitors with honest tradeoffs. We had no comparison content at all.
- **Caretta posts follow one template**, ~1,100-1,400 words: a definition-style first paragraph written to be quoted by answer engines, an H2 outline, one comparison table, a 4-5 question FAQ, 2+ internal links to other posts and product pages, a closing CTA, byline "Caretta Team", date and reading time. Categories: Company / Product / Thinking. Cadence: one post per day for the last ten days.
- **Caretta's structured data is thorough**: every post carries `BlogPosting` + `BreadcrumbList` + `FAQPage` JSON-LD on top of site-wide `Organization`, `SoftwareApplication`, `WebSite`. Title pattern `<Post> | Caretta Blog`, canonical, `og:type=article`, `article:published_time` and `article:modified_time`. Parakeet's homepage has only `Organization` + `SoftwareApplication` + `WebSite`.
- **Caretta has an `llms.txt`** (product summary, "When to use" bullets, links to docs, MCP server, OpenAPI). Parakeet's is a 404.
- **Blog on the main domain matters.** Parakeet's blog lives on a Ghost subdomain (`blog.parakeet-ai.com`) and is absent from the main sitemap; Caretta's is under `/blog` with every post in the sitemap. Caretta is the pattern to copy.
- **Keyword themes are narrow and repeated**: Caretta owns "real-time AI sales assistant"; Parakeet owns "real-time AI interview assistant" and sells "invisible on screen share". Our equivalent theme is "local-first meeting assistant" / "bring your own model", and we deliberately do not follow the invisibility angle (see FAQ and the consent post).

**Implemented:** `/blog` on the main domain, `BlogPosting` + `BreadcrumbList` JSON-LD per post and `Blog` on the index, `og:type=article` with `publishedTime` and tags, canonical URLs, sitemap entries with `lastModified`, `public/llms.txt`, definition-style openers, date + reading time + tags, 2-6 internal links per post, closing CTA, one bottom-of-funnel comparison post, one definitional/how-it-works post, two how-to posts, one trust post.

**Deliberately skipped:** named-competitor "vs" pages (we have no verified feature data on competitors and should not start with claims about others; the comparison post is category-level); `FAQPage` JSON-LD on posts (Google dropped FAQ rich results for most sites in 2023, and the homepage already carries the FAQ); comparison tables (not in the Markdown subset; see below); author bylines (author is the `Organization`); categories (tags cover it); RSS; a per-post OG image (posts inherit the root `opengraph-image`).

## Posts

| Date | Slug | Title | Funnel |
| --- | --- | --- | --- |
| 2026-09-06 | `local-first-meeting-assistant-vs-meeting-bots` | Local-first meeting assistants vs bots that join the call | bottom |
| 2026-09-05 | `bring-your-own-model-claude-code-codex` | Bring your own model, with the CLI you already pay for | middle |
| 2026-09-04 | `when-savvy-speaks-up` | How Savvy decides when to speak | middle |
| 2026-09-03 | `what-to-prepare-before-a-negotiation-call` | What to prepare before a negotiation call | top |
| 2026-09-02 | `meeting-recording-consent-and-etiquette` | Recording a meeting: consent, etiquette, and why Savvy has no hidden mode | top / trust |

Routes: `/blog/` and `/blog/<slug>/` (trailing slash, matching `next.config.ts`). Both use `<Rail active="/blog" />`, so the nav highlights once `/blog` is added to `NAV`.

## How to add a post

1. Create `src/content/blog/<slug>.md`. The filename is the URL.
2. Start with a frontmatter block. `title`, `description` and `date` are required; the build fails with the filename if one is missing or the date is not `YYYY-MM-DD`.

   ```
   ---
   title: Plain title a person would write
   description: 150-160 characters, this is the meta description and the lead paragraph.
   date: 2026-09-07
   tags: two, to four, tags
   ---
   ```

3. Write the body in the supported Markdown subset: `##` and `###` headings, paragraphs, `-` and `1.` lists, `>` quotes, `---` rules, `**bold**`, `` `code` ``, and `[links](url)`. Internal links start with `/` and render as `next/link`; external links open in a new tab. Anything else (tables, images, nested lists, headings deeper than `###`) renders as plain text.
4. Voice rules the existing posts follow: short sentences, no hype words, no em dashes, straight quotes, nothing the README does not support, no "hidden from screen share" angle.
5. `pnpm typecheck && pnpm exec biome check --write src && pnpm build`. The sitemap, index, JSON-LD and `generateStaticParams` all read the directory, so nothing else needs editing. Add the post's URL to `public/llms.txt` by hand.

Reading time is words / 220, rounded up. Posts sort by `date` descending; same-day posts keep directory order.

## Recommended, not built

- **Comparison table support** in `src/components/blog/Markdown.tsx` (about 15 lines). Caretta uses one per post and it is the most-quoted block in answer engines. Add when a post needs it.
- **Named "vs" pages** under `/compare/` once someone has verified each competitor's current feature set against their own docs. Parakeet's hub-plus-five-pages layout is the template.
- **RSS feed** (`src/app/feed.xml/route.ts` with `force-static`). Cheap, and the Ghost-hosted competitor blog has one.
- **`dateModified`** in frontmatter. Currently `dateModified` equals `datePublished`; add an optional `updated` field when a post is revised.
- **Per-post OG image** using the existing `opengraph-image.tsx` pattern with the post title, if social shares matter.
- **Swap `SITE_URL`** in `src/lib/constants.ts` before deploy; every canonical, sitemap and `llms.txt` URL derives from it (the `llms.txt` ones are hard-coded and need a find-and-replace).
