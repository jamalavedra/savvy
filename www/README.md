# Savvy website

Static Next.js site for Savvy. The desktop app lives in the repository root.
The FAQ uses native HTML; entrance animations use CSS.

## Development

```sh
pnpm install --frozen-lockfile
pnpm dev        # localhost:3012
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
CLOUDFLARE_ACCOUNT_ID=<intended-account-id> pnpm deploy
```

Sign into the Cloudflare account that owns `savvycopilot.com`. Verify the account
before deploying, especially if Wrangler was previously used with another account.
Never commit credentials. The configuration deliberately has no account ID or route
until the owning account and active DNS zone have been verified.

After verification, add a custom-domain route to `wrangler.jsonc`:

```json
"routes": [{ "pattern": "savvycopilot.com", "custom_domain": true }]
```

`SITE_URL` in `src/lib/constants.ts` controls canonical URLs, social metadata,
robots.txt and the sitemap. It is set to `https://savvycopilot.com`.
CI validates the site but does not deploy it.

## Assets

Mascot images come from `src/assets/mascot-states` in the desktop app and the icon
from `src-tauri/icons`. Video attribution is in `public/videos/SOURCE.md`.
