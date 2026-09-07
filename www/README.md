# Savvy website

Static Next.js site for Savvy. The desktop app lives in the repository root.
The FAQ uses native HTML; entrance animations use CSS.

## Development

```sh
pnpm install --frozen-lockfile
pnpm dev        # localhost:3012
pnpm typecheck
pnpm lint
pnpm build      # static files in out/; includes TypeScript checking
pnpm start      # serve the export locally with Wrangler
pnpm deploy:check
```

## Cloudflare deployment

Wrangler serves `out/` as Worker static assets, with no application server.
The CLI version is pinned in the scripts and downloaded by pnpm when needed.

```sh
pnpm dlx wrangler@4.127.1 login
pnpm dlx wrangler@4.127.1 whoami
CLOUDFLARE_ACCOUNT_ID=<intended-account-id> pnpm run deploy
```

Sign into the Cloudflare account that owns `savvycopilot.com`. Verify the account
before deploying, especially if Wrangler was previously used with another account.
Never commit credentials. The custom-domain route is configured for
`savvycopilot.com`. Pass the verified account ID when deploying; no account ID is
stored in the repository.

`SITE_URL` in `src/lib/constants.ts` controls canonical URLs, social metadata,
robots.txt, the sitemap and llms.txt. It is set to `https://savvycopilot.com`.
CI validates the site but does not deploy it.

## Blog

Posts are Markdown files in `src/content/blog/`. The filename is the URL slug.
Start each file with a frontmatter block; `title`, `description` and `date` are
required and the build fails naming the file if one is missing or the date is not
`YYYY-MM-DD`.

```
---
title: Plain title a person would write
description: 150-160 characters, this is the meta description and the lead paragraph.
date: 2026-09-07
tags: two, to four, tags
---
```

The body supports `##` and `###` headings, paragraphs, `-` and `1.` lists, `>`
quotes, `---` rules, `**bold**`, `` `code` `` and `[links](url)`. Internal links
start with `/` and render as `next/link`; external links open in a new tab.
Anything else renders as plain text. Keep to the voice of the existing posts:
short sentences, no hype, no em dashes, straight quotes, nothing the root README
does not support. The sitemap, blog index, JSON-LD and `/llms.txt` all read the
directory, so nothing else needs editing. Reading time is words / 220, rounded up.
Posts sort by `date` descending.

## Assets

Mascot images come from `src/assets/mascot-states` in the desktop app and the icon
from `src-tauri/icons`. Video attribution is in `public/videos/SOURCE.md`.

## Privacy and analytics

The privacy notice is at `/privacy/`. The site loads optional Umami analytics only after an
explicit choice in the privacy preferences. A choice lasts up to one year in this
browser; withdrawing it reloads the page to stop the tracker. Run
`node --test smoke.test.mjs` after building to check the export and consent records.
