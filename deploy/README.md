# Deploying the backend

Savvy managed assistance runs as one `backend/` package: one Node process, one
listener and one systemd unit. It owns auth, billing, sessions, WebSockets and AI
requests. Both SQLite databases live under `/var/lib/savvy/`. The marketing website
is a static export; no second application server or worker is required.

The backend has not run in production yet. Linux deployment, owned domains, real
supplier output and the installed desktop journey are not covered by the fixture
tests. Complete the acceptance checks at the end of this file before opening it to
customers.

## Build and package

Use the pinned Node/pnpm versions and install native SQLite dependencies on the
host architecture:

```sh
pnpm --dir backend install --frozen-lockfile
pnpm --dir backend build
```

A backend release needs `backend/build/`, `backend/dist/`, `backend/package.json`,
the lockfile, production `node_modules`, and `config/managed-catalog.json` at the
release root alongside `backend/`. Preserve that relative path; the compiled catalog
module reads it. Run migrations with `node build/migrate.js` and start with
`node build/server.js` from the package working directory. TypeScript tooling is not
a runtime requirement. Deploy frontend assets and the compiled server from the same
build.

Create a dedicated `savvy` system user. Keep a release directory under
`/opt/savvy/releases/<release-id>/` and point `/opt/savvy/current` to that release.
`deploy/savvy-backend.service` starts the compiled backend. The environment file is
`/etc/savvy/backend.env`, owned by root and readable by the service group, mode 0640.
Use `backend/.env.example` as the configuration inventory. The unit sets persistent
database paths and the loopback listener. Values in `/etc/savvy/backend.env` override
these unit settings, so do not set `SAVVY_HOST`, `PORT`, `SAVVY_AUTH_DATABASE` or
`SAVVY_DB_PATH` there. Run only one instance.

The unit uses the pinned official Node runtime at
`/opt/node-v22.23.2-linux-x64/bin/node`. Download its Linux x64 archive and
`SHASUMS256.txt` from `https://nodejs.org/dist/v22.23.2/`, verify the archive
with SHA-256 before extracting it into `/opt`, and verify the installed version.
Keep this path in sync with the repository Node pin.

The unit sends SIGINT and allows 150 seconds. Node rejects new paid work, aborts AI,
settles observed relay audio and releases all remaining meeting reservations before
closing both databases. Its own 140-second fallback exits unsuccessfully if drain
cannot finish. Startup recovery releases unfinished reservations. Supplier recovery,
purchases and sign-in never resume listening automatically.

## Ingress and configuration

Desktop auth, managed HTTP and audio WebSockets use one public origin, which is
`BETTER_AUTH_URL`. In production that is `https://api.savvycopilot.com`, with no
trailing slash, and `SAVVY_OIDC_AUDIENCE` has the same value. Release desktop builds
default to exactly these values, so the issuer check fails on any difference. Set
the signing secret and the native client ID before the first sign-in. Never change
any of these afterwards: installed desktops, refresh tokens and account identities
depend on them. Any alias hostname must terminate at this same backend.

On Epistoma, use the existing remotely managed Cloudflare Tunnel directly:
`api.savvycopilot.com` routes to `http://127.0.0.1:8788` and the separate staging
hostname routes to `http://127.0.0.1:8789`. Insert each ingress rule before the
catch-all without changing unrelated routes. Create proxied DNS records pointing
to the existing tunnel. Keep auth/API responses uncached and pass Authorization,
raw Stripe webhook bodies, and WebSocket upgrades without interactive challenges.

Set `SAVVY_AUTH_TRUSTED_PROXIES=127.0.0.1` and
`SAVVY_AUTH_PROXY_IP_HEADER=cf-connecting-ip`. Only exact trusted socket peers
can supply the selected address. Missing, malformed, repeated, or comma-separated
values from those peers return 400; there is no fallback to a caller's custom
header. The default selector remains `x-savvy-proxy-ip` for standalone nginx.
Loopback readiness probes must include the selected header:

```sh
curl --fail -H 'CF-Connecting-IP: 127.0.0.1' http://127.0.0.1:8788/ready
curl --fail -H 'CF-Connecting-IP: 127.0.0.1' http://127.0.0.1:8788/readyz
```

`deploy/auth-proxy.conf.example` is a standalone nginx alternative. It preserves
raw bodies, Authorization and upgrades, but its `$remote_addr` forwarding would
attribute every visitor to cloudflared if placed behind the tunnel. That topology
needs explicit trusted real-client-IP handling and is not used on Epistoma.

Staging uses its own `savvy-staging` user, `/var/lib/savvy-staging` state,
`/etc/savvy/staging.env`, `/opt/savvy/staging` release link, issuer/audience
`https://staging-api.savvycopilot.com`, and client ID `savvy-desktop-staging`.
Adapt the existing unit's user, group, working directory, environment file, state
and writable paths, and port; preserve its drain and hardening settings. Restrict
only the staging hostname to the current test-machine egress IPs, except the
signed `/v1/billing/webhook` route. Use real identity/SMTP and suppliers with
Stripe test-mode credentials. Never copy staging state or test grants to production.

Configure Google identity, SMTP, Stripe and the transcription and AI suppliers in the
protected environment. Do not embed secrets in desktop builds. Offer prices come
from `config/managed-catalog.json`, and the configured Stripe Prices must match it.
The service records each sold Price, so renewals and delayed payments keep their
original allowance after the catalog changes. Production requires
`SAVVY_STRIPE_SECRET_KEY`, `SAVVY_STRIPE_WEBHOOK_SECRET`,
`SAVVY_STRIPE_PRICE_MONTHLY` and `SAVVY_STRIPE_PRICE_PACK`, and must not set
`SAVVY_ALLOW_UNMETERED`. Keep development grants disabled outside isolated local
fixtures. Stripe-hosted return pages trigger refresh and never prove payment.

## First install

1. Create `/var/lib/savvy/` owned by the `savvy` user, mode 0700.
2. Write `/etc/savvy/backend.env` with a new random `BETTER_AUTH_SECRET` of at least
   32 characters. Store a copy of the secret outside the host.
3. Run the auth migration once as the `savvy` user with the environment loaded.
   Service schema migrations are additive and run at backend startup.
4. Start the unit. Check `GET /ready` and `GET /readyz`, sign in from a desktop
   build that points at this origin, and read the account before opening purchases.

## Upgrade, backup and rollback

To upgrade, stop the unit, take a backup, point `/opt/savvy/current` at the new
release, run `node build/migrate.js` and start the unit again. Keep the previous
release directory until the new one has passed readiness and a sign-in check.

For backups, stop the backend and run
`pnpm --dir backend backup /path/to/new-private-backup` with its environment loaded.
The command locks both databases, uses SQLite's backup API, checks integrity and
writes a manifest with hashes. Protect the two snapshots and the auth secret.
Restoration steps are in `backend/README.md`.

Roll back by starting the previous release against a fresh copy of current state,
so paid usage since the upgrade is kept. Never restore an older snapshot without
reconciling payments and usage since that snapshot. Reopen purchases only after
recovering uncertain checkout identities.

## Acceptance still required

Follow [`backend/e2e/managed-acceptance.md`](../backend/e2e/managed-acceptance.md)
for the installed-app, hosted-provider, operations and release checks.
Run root `pnpm verify`, the backend browser checks, the desktop issuer tests and the
website lint, typecheck, build and smoke checks. Complete the five-minute mixed load
test, the installed macOS journey and a security review of the final build.

Hosting, owned domains, Linux/systemd/tunnel behavior, Google and external SMTP, real
supplier output, Stripe test-mode payments, customer policies and production signing
still need configuration and a staging run.

## Local Stripe sandbox

Load a private backend environment with a loopback `BETTER_AUTH_URL`, an auth secret
you keep across restarts, SMTP configuration and supplier credentials. Keep the
Stripe test selectors in `~/.config/savvy/stripe-test.env`. Start the static return
site on loopback port 18789 and an SMTP catcher when testing local delivery.

```sh
pnpm --dir backend build
python3 scripts/stripe-sandbox.py
```

The launcher starts the compiled backend and a Stripe CLI test-webhook forwarder.
Better Auth and managed APIs use the same origin. It does not create payments, grant
allowance or replace suppliers with successful fixtures. Its private state defaults
to `target/unified-stripe-e2e/`; reuse the same auth secret across restarts.

With the sandbox running, the opt-in desktop transport check exercises real PKCE
sign-in. Set `SAVVY_E2E_DIR` to the sandbox's private directory and run
`cargo test -p savvy --lib local_stripe_sandbox_desktop_transport --locked -- --ignored`.
The check writes `authorization.json`; a browser driver completes the normal sign-in
page and writes the one-use native callback to `callback.txt`. Rust owns PKCE
validation and token exchange. The default action only reads the account;
`SAVVY_E2E_PRODUCT=monthly`, `pack` or `portal` opens a test billing operation.
Hosted payment submission remains a separate explicit action.
