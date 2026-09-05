# Savvy landing site

The marketing site for [Savvy](https://github.com/jamalavedra/savvy), a local-first macOS
meeting assistant. The app itself lives in the repository root; this folder only contains
the public website.

## Stack

- Next.js 16 (App Router)
- Tailwind CSS 4
- framer-motion for motion, Radix UI accordion for the FAQ
- Biome for linting and formatting

## Commands

```bash
pnpm install
pnpm dev        # http://localhost:3012
pnpm build      # static export into out/
pnpm lint       # biome check
pnpm typecheck  # tsc --noEmit
```

## Deploying

`pnpm build` writes a static export to `out/`, which any static host can serve — GitHub
Pages, Cloudflare Pages, S3, Netlify. There is no server runtime and no API routes.

Set `SITE_URL` in `src/lib/constants.ts` to the real domain before deploying. It is used
for canonical URLs, Open Graph tags, `robots.txt` and the sitemap.

## Assets

Images in `public/images` are copied from the app: the mascot states come from
`src/assets/mascot-states` and the icon from `src-tauri/icons`. Update them there first,
then copy the new files across.
