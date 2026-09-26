# Single-backend handoff

The target is one `backend/` package, one Node process, one listener and one
systemd unit. It owns auth, billing, sessions, WebSockets and AI requests. Both
SQLite databases live under `/var/lib/savvy/`. The marketing website is a static
export; no second application server or worker is required.

This work is local. Linux deployment, owned domains, real supplier acceptance and
remaining native/visual gates are not verified by fixture tests. Do not deploy the
backend until the acceptance checks below pass.

## Build and package

Use the pinned Node/pnpm versions and install native SQLite dependencies on the
chosen host architecture:

```sh
pnpm --dir backend install --frozen-lockfile
pnpm --dir backend build
```

A backend release needs `backend/build/`, `backend/dist/`, `backend/package.json`,
the lockfile, production `node_modules`, and the shared
`config/managed-catalog.json` at the release root alongside `backend/`. Preserve
that relative path; the compiled catalog module reads this shared asset. Run migrations with
`node build/migrate.js` and start with `node build/server.js` from the package
working directory. TypeScript tooling and a Rust service executable are not runtime
requirements. Keep frontend assets and compiled server from the same build.

Create a dedicated `savvy` system user. Keep a release directory under
`/opt/savvy/releases/<release-id>/` and point `/opt/savvy/current` to that release.
`deploy/savvy-backend.service` starts the compiled backend. The environment file is
`/etc/savvy/backend.env`, owned by root and readable by the service group, mode 0640.
Use `backend/.env.example` as the configuration inventory. The unit sets persistent
database paths and the loopback listener. Run only one instance.

The unit sends SIGINT and allows 150 seconds. Node rejects new paid work, aborts AI,
settles observed relay audio and releases all remaining meeting reservations before
closing both databases. Its own 140-second fallback exits unsuccessfully if drain
cannot finish. Startup recovery releases unfinished reservations. Supplier recovery,
purchases and sign-in never resume listening automatically.

## Ingress and configuration

Preserve the existing auth hostname as `BETTER_AUTH_URL`, plus the signing secret,
issuer/subject identities, native client ID and resource audience. Desktop auth,
managed HTTP and audio WebSockets use that same public origin. Existing hostname
aliases, if retained during migration, must terminate at this same backend.

`deploy/auth-proxy.conf.example` has one loopback upstream. It preserves the raw
webhook body and Authorization header, supports WebSocket upgrades and applies a
64-KiB auth limit and one-MiB managed limit. Configure the exact proxy peer in
`SAVVY_AUTH_TRUSTED_PROXIES`; the proxy overwrites the client-address header.
Supply the owned-domain TLS configuration before validating it with `nginx -t`.
The example cannot validate certificates or public routing locally.

Configure Google identity, SMTP, Stripe catalog selectors/webhook secret and the
transcription/AI suppliers in the protected environment. Do not embed secrets in
desktop builds. Preserve the accepted $79 monthly/$29 pack catalog and stored
historical offer identities. Keep development grants disabled outside isolated
local fixtures. Stripe-hosted return pages trigger refresh and never prove payment.

## Migration, backup and rollback

1. Close admissions and drain both old services. Confirm their processes exited.
2. Preserve the old executables, environment and catalog. Take consistent SQLite
   snapshots and retain the matching auth secret separately. Never run both old and
   new implementations as writers against the same service database.
3. Test copies in a fresh private state directory. Preserve every account's
   issuer/subject pair, balances, usage, subscriptions, purchases and signing keys.
   No email-based identity mapping or financial reset is part of this migration.
4. Run the compiled auth migration with the retained secret and issuer. Service
   migrations are additive and run at backend startup. The databases remain
   separate files. The new unit requires ownership by the `savvy` service user.
5. Start only the unified unit after acceptance. Verify combined readiness, auth,
   refresh and financial state before reopening admissions. Disable the old auth
   and Rust units when performing an approved deployment.

For subsequent backups, stop the unified backend and run
`pnpm --dir backend backup /path/to/new-private-backup` with its environment loaded.
The command locks both databases, uses SQLite's backup API, checks integrity and
writes a manifest with hashes. Protect the two snapshots and original auth secret.
Detailed restoration checks are in `backend/README.md`.

Rollback must use a compatible previous executable against a fresh copy of current
state, preserving paid usage since migration. Never restore an older snapshot without
reconciling payments and usage since that snapshot. Reopen purchases only after
recovering uncertain checkout identities and historical mappings.

## Acceptance still required

Run root `pnpm verify`, backend browser checks, desktop issuer tests and website
lint/typecheck/build/smoke checks. Complete the five-minute mixed load, installed
macOS journey and a security review of the final build.

Hosting, owned domains, Linux/systemd/nginx behavior, Google and external SMTP,
real supplier output, Stripe sandbox integration for the Node replacement, customer
policies and production signing remain configuration or acceptance gates.

## Local Stripe sandbox

Load a private backend environment with a loopback `BETTER_AUTH_URL`, retained
auth secret, SMTP configuration and supplier credentials. Keep the Stripe test
selectors in `~/.config/savvy/stripe-test.env`. Start the static return site on
loopback port 18789 and an SMTP catcher when testing local delivery.

```sh
pnpm --dir backend build
python3 scripts/stripe-sandbox.py
```

The launcher starts the compiled Node backend and a Stripe CLI test-webhook
forwarder. Better Auth and managed APIs use the same origin. It does not create
payments, grant allowance or replace suppliers with successful fixtures. Its
private state defaults to `target/unified-stripe-e2e/`; reuse the same auth secret
across restarts. A legacy synthetic-issuer state directory is refused.

The opt-in Rust transport check now starts real PKCE instead of device-code
fixtures. With the sandbox running, set `SAVVY_E2E_DIR` to its private directory and
run `cargo test -p savvy --lib local_stripe_sandbox_desktop_transport --locked -- --ignored`.
The check writes `authorization.json`; a browser driver completes the normal
sign-in page and writes the one-use native callback to `callback.txt`. Rust owns
PKCE validation and token exchange. The default action only reads the account;
`SAVVY_E2E_PRODUCT=monthly`, `pack` or `portal` opens a test billing operation.
Hosted payment submission remains a separate explicit action. This command is
opt-in because it requires the configured real sandbox and browser handoff.
