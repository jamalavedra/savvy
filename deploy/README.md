# Deploying the backend

Savvy managed assistance runs as one `backend/` package: one Node process, one
listener and one systemd unit. It owns auth, billing, sessions, WebSockets and AI
requests. Both SQLite databases live under `/var/lib/savvy/`. The marketing website
is a static export; no second application server or worker is required.

The production backend runs on Epistoma behind the Cloudflare Tunnel at
`https://api.savvycopilot.com`. The website runs on the `savvy-www` Cloudflare
Worker. Fixture tests do not replace installed-app acceptance: complete the checks
at the end of this file against each candidate release before opening it to customers.

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
`/opt/node-v22.23.4-linux-x64/bin/node`. Download its Linux x64 archive and
`SHASUMS256.txt` from `https://nodejs.org/dist/v22.23.4/`, verify the archive
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

### Connected-source rollout

The release exposes Salesforce, HubSpot, Gmail, Outlook, Notion and Google Drive.
Gong connection and read requests are disabled until live acceptance is complete;
disconnect remains available for an existing Gong account. Keep its local source
copies and selections intact.

Configure `COMPOSIO_API_KEY` privately in the production environment before
connected-source rollout. It was absent in the read-only production check on
25 October 2026. Readiness alone does not verify this optional feature. The key
must permit session creation and proxy execution. Never print it, embed it in a
desktop build, or copy staging databases or test grants to production.

Composio identities combine a SHA-256 digest of the exact backend issuer with the
internal account ID. Cached sessions are bound to that full identity. Different
issuers can therefore share a Composio project without sharing their connected
accounts, even when both databases allocate the same numeric ID. A different API
key in the same project is not itself an isolation boundary. Preserve the issuer
and verify issuer separation before rollout.

The additive cache migration preserves legacy session rows but never reuses them
until a matching identity is stored. Existing legacy `savvy:4` connections stay
untouched in Composio; they are not transferred to the new staging identity.
Reconnect the six providers under that identity and repeat live adapter/import
acceptance before treating the new candidate as verified. User-owned local copies
remain available, with the existing saved-copy or exclude choice after a failed
refresh. Do not restore an older financial database to roll back a session cache.

Merging into main can deploy the backend automatically after Verify passes.
Preparing a candidate does not require merging it. The desktop candidate is
version 0.1.4; complete checks on the final commit, then build signed/notarized
draft artifacts and run the production-client smoke before publishing the release.

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

The `Deploy backend` GitHub workflow runs after a successful main-branch
`Verify` run. Its Tailscale federated identity uses the repository variables
`TS_CI_CLIENT_ID` and `TS_CI_AUDIENCE` to reach Epistoma and run
`deploy/epistoma-main.sh` for that exact commit. The script builds a new release,
takes a stopped-state backup, switches the release link, migrates, and checks
readiness. If migration fails, the backup timer stays stopped for operator
recovery; review the backup and current databases before any rollback.

To upgrade, stop the unit, take a backup, point `/opt/savvy/current` at the new
release, run `node build/migrate.js` and start the unit again. Keep the previous
release directory until the new one has passed readiness and a sign-in check.
If scheduled backups are enabled, first stop both `savvy-backup.timer` and
`savvy-backup.service`, letting the backup's restart callback finish before the
maintenance stop. Re-enable the timer only after recovery checks pass.

For backups, stop the backend and run
`pnpm --dir backend backup /path/to/new-private-backup` with its environment loaded.
The command locks both databases, uses SQLite's backup API, checks integrity and
writes a manifest with hashes. Protect the two snapshots and the auth secret.
Restoration steps are in `backend/README.md`.

### Daily production backups

After production identity, billing and installed-app drain acceptance pass, install
the Savvy-only backup job before opening customer admission:

```sh
sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 deploy/savvy-backup.sh /usr/local/libexec/savvy-backup
sudo install -d -o savvy -g savvy -m 0700 /var/backups/savvy
sudo install -m 0644 deploy/savvy-backup.service deploy/savvy-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start savvy-backup.service
sudo systemctl status savvy-backup.service --no-pager
```

The job first requires an active production backend. It records that restart is
needed, normally drains the backend, and runs the existing compiled backup command
as `savvy`. `ExecStopPost` restarts the backend after success, failure or process
termination. A failed restart keeps its root-only marker for recovery; the job
does not start an intentionally inactive backend. Node reads the protected env
file without sourcing it into a shell or printing credentials.

Snapshots are new timestamped directories under `/var/backups/savvy`, mode 0700,
with both SQLite files and the hash/integrity/signing-key manifest mode 0600.
The matching stable `BETTER_AUTH_SECRET` remains in the separate protected store.
Keep a protected off-host copy of that secret and both snapshots. On this Mac,
use a 0700 directory outside Git with FileVault enabled and `umask 077`; SSH can
stream the selected backup without making the VPS files publicly readable:

```sh
umask 077
ssh jaume@epistoma 'sudo tar -C /var/backups/savvy/EXACT_TIMESTAMP -czf - auth.sqlite service.sqlite manifest.json' > savvy-backup.tar.gz
```

Record the actual off-host destination in the private rollout manifest. Verify
manifest hashes, SQLite integrity and a private restore with the matching issuer,
secret and signing identity before enabling the timer. Do not copy staging state
to production or restore an older ledger over newer payments. To test a restore,
copy the pair to a new private directory owned by `savvy`, then run the matching
compiled backend with database paths pointing only to that copy and a loopback
port that has no public tunnel route:

```sh
sudo runuser -u savvy -- env \
  SAVVY_AUTH_DATABASE=/var/lib/savvy-restore/EXACT_TIMESTAMP/auth.sqlite \
  SAVVY_DB_PATH=/var/lib/savvy-restore/EXACT_TIMESTAMP/service.sqlite \
  SAVVY_HOST=127.0.0.1 PORT=8790 \
  /opt/node-v22.23.4-linux-x64/bin/node --env-file=/etc/savvy/backend.env \
  /opt/savvy/releases/EXACT_MATCHING_SHA/backend/build/server.js
```

Check `/ready` using `CF-Connecting-IP: 127.0.0.1`, signing key IDs, refresh rotation
and current payments/allowances/usage/purchases. Stop the clone normally afterward.
Keep the live DB pair unchanged during the drill. After this gate passes:

```sh
sudo systemctl enable --now savvy-backup.timer
sudo systemctl list-timers savvy-backup.timer --all --no-pager
```

The timer runs at 03:00 UTC and catches missed runs after downtime. Each backup
briefly interrupts the service; desktop listening must resume explicitly. Monitor
failed backup/restart units and off-host copy freshness by configuring the Savvy
monitor before enabling the timer. Inspect failures with `journalctl -u savvy-backup.service`; if the
backend did not restart, recover it with `systemctl start savvy-backend.service`
and verify readiness and reservation recovery before reopening access.

Roll back using the current release controller and current financial state.
The installed `/usr/local/libexec/savvy-release.mjs` runs the CURRENT backend's
packaged `rollback-preflight.js` before atomically switching `/opt/savvy/current`.
It checks the database floor, acquisition flag and team payment records against
the candidate's built `service-capabilities.json`. Missing metadata means 0.
A bootstrap from a legacy release uses the new checkpoint's guard; later changes
use the current guard, including when the candidate itself has no guard.

With the backend stopped and the backup timer paused, run:

```sh
sudo /opt/node-v22.23.4-linux-x64/bin/node /usr/local/libexec/savvy-release.mjs check /opt/savvy/current /opt/savvy/releases/<candidate-sha> /var/lib/savvy/service.sqlite
sudo /opt/node-v22.23.4-linux-x64/bin/node /usr/local/libexec/savvy-release.mjs switch /opt/savvy/current /opt/savvy/releases/<candidate-sha> /var/lib/savvy/service.sqlite
```

Only restart after a successful switch and readiness check. An incompatible
candidate leaves the link unchanged. The deploy script uses this path for both
upgrade and automatic rollback before migration. A failed post-migration deploy
still requires stopped-state investigation and a guarded compatible candidate.
Never restore an older financial database or erase pending payment intents to
make an old release pass. Reconcile uncertain checkouts before reopening purchases.

### Team rollout and activation

Ship the capability-1 schema/personal-compatibility checkpoint with acquisition
disabled. It is not a paid-seat rollback target. Complete the organization browser,
native Mac/Windows and Stripe TEST staging acceptance before declaring the complete
release capability 2. Package `service-capabilities.json`, `capability.js` and
`rollback-preflight.js`; no TypeScript tooling is needed in production.

In controlled maintenance, preserve a complete capability-2 release as the
checkpoint and stop the service. With the existing Stripe key loaded privately,
run `pnpm capability configure-team-portal --db /var/lib/savvy/service.sqlite
--configuration <bpc_id>` from the current backend package. This retrieves and
validates the dedicated configuration using the pinned Stripe API version before
saving it. It must be active, allow cancellation and disable subscription updates.
Activation refuses a missing configuration, and every portal opening checks the
current settings again. Then run the current backend package's
`pnpm capability activate-team-purchases --db /var/lib/savvy/service.sqlite
--checkpoint-commit <complete-sha> --checkpoint-manifest
<complete-release>/backend/build/service-capabilities.json`. This atomically
records required capability 2 and the immutable checkpoint before enabling new
team payment operations. Resume one backend and verify personal and seat spending.
Use `disable-team-purchases --db ...` to stop new acquisition without erasing the
floor, existing invitations, paid grants or reconciliation. Rollback to capability
0 or 1 is permanently refused after activation, even before the first seat grant.

`/team` and `/team/join` use the existing public origin and SMTP transport. No new
environment variables or webhook event types are required. The organization portal
configuration allows cancellation and payment maintenance, but disallows quantity
edits. Verify that configuration in real Stripe TEST staging before activation.
Do not announce team checkout or enable acquisition until staging TEST-018 through
TEST-021 and production TEST-016 are recorded against the final candidate. No
production purchase is authorized by these acceptance instructions.

### Production monitoring

Install the Savvy-only monitor after the backend and backup units are installed.
It runs each minute and writes aggregate JSON to the local journal. It checks
origin and public readiness, backend/backup failures, reservations more than one
minute past their lease/deadline, pending billing events older than five minutes,
negative allowances, provider/reconciliation errors in the last five minutes and
free disk space. It fails below 1 GiB free or 10% free. A running scheduled backup
suppresses only the expected readiness interruption. Failed/canceled provider
operations are counted separately; cancellation alone does not trigger a failure.

```sh
sudo install -m 0644 deploy/savvy-monitor.py /usr/local/libexec/savvy-monitor.py
sudo install -m 0644 deploy/savvy-monitor.service deploy/savvy-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start savvy-monitor.service
sudo journalctl -u savvy-monitor.service -n 5 --no-pager
sudo systemctl enable --now savvy-monitor.timer
```

The monitor reads SQLite in read-only mode and never emits identities, event IDs,
audio, context, credential values or raw supplier error bodies. Its current
destination is journald on Epistoma; no external message is sent. Record that
destination and test an unhealthy state before opening admission. Review
`journalctl -u savvy-monitor.service --since=-24h` during launch observation.
The local timer cannot detect an unreachable VPS while it is down. Public
readiness must also be observed every minute from a separate machine during the
24-hour launch gate, and an existing external monitor should be connected before
leaving production unattended. A failed monitor does not stop or restart the
backend automatically.

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
