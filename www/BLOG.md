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
5. `pnpm typecheck`, `pnpm lint:fix`, `pnpm lint`, then `pnpm build`. The sitemap, index, JSON-LD, `/llms.txt` and `generateStaticParams` all read the directory, so nothing else needs editing.

Reading time is words / 220, rounded up. Posts sort by `date` descending; same-day posts keep directory order.

## Posts

| Date | Slug | Title | Funnel |
| --- | --- | --- | --- |
| 2026-09-06 | `local-first-meeting-assistant-vs-meeting-bots` | Local-first meeting assistants vs bots that join the call | bottom |
| 2026-09-05 | `bring-your-own-model-claude-code-codex` | Bring your own model, with the CLI you already pay for | middle |
| 2026-09-04 | `when-savvy-speaks-up` | How Savvy decides when to speak | middle |
| 2026-09-03 | `what-to-prepare-before-a-negotiation-call` | What to prepare before a negotiation call | top |
| 2026-09-02 | `meeting-recording-consent-and-etiquette` | Recording a meeting: consent, etiquette, and why Savvy has no hidden mode | top / trust |
