# Savvy backend

One Node process serves Better Auth, React sign-in pages, account and billing APIs,
meeting sessions, transcription WebSockets, briefs and advice. Billing reconciliation
and session expiry run inside that process. The desktop remains Rust/Tauri and the
marketing website stays statically exported.

The backend has not been deployed. [`deploy/README.md`](../deploy/README.md) lists
the acceptance checks that remain before it can be.

## Local setup

The repository pins Node 22.23.2 and pnpm 10.34.5. Build native dependencies on the
machine that will run the backend. From the repository root:

```sh
pnpm --dir backend install --frozen-lockfile
pnpm --dir backend build
```

Copy `backend/.env.example` to a private environment file, mode 0600, and fill in
its configuration. For a new isolated test account, provide a random secret of at
least 32 characters. For existing accounts, retain the issuer, signing secret,
client ID, resource audience, auth database and service database. Use copied
databases for migration testing. Create their parent directory before starting;
it must belong to the backend user and must not be writable by other users.
Database files are created with mode 0600 before SQLite opens them. Symlinks,
hardlinks and foreign-owned database files or sidecars are refused.

Load the environment, then run the compiled auth migration and backend:

```sh
set -a
source /path/to/private/backend.env
set +a
pnpm --dir backend migrate
pnpm --dir backend start
```

The default listener is `127.0.0.1:8788`. Set desktop `SAVVY_SERVICE_URL` and
`SAVVY_OIDC_ISSUER` to the configured `BETTER_AUTH_URL`. The resource audience is an
identity value and need not equal that URL. Keep existing audience values.

`SAVVY_AUTH_DATABASE` contains users, sessions, OAuth grants and encrypted signing
keys. `SAVVY_DB_PATH` contains the existing billing ledger, subscriptions, purchases
and usage. They must be distinct files. Both belong to the one backend. Never run
the Rust reference and Node as writers against the same service file.

Configure SMTP and a Google OAuth web client with `/api/auth/callback/google` on
`BETTER_AUTH_URL`. Google receives identity scopes only. SMTP outside loopback
requires TLS. A local mail catcher on port 1025 supports manual tests; automated
checks start their own SMTP catcher. `GET /ready` reports auth schema/configuration
readiness. `GET /readyz` checks both databases and fails during drain. Neither
endpoint proves external suppliers are working.

The native client uses `com.alamaslabs.savvy:/oauth/callback`, authorization code
with S256 PKCE, RS256 access tokens and rotating refresh tokens. Registration is
closed. Migrations preserve existing client/resource rows. Billing identity remains
verified issuer plus subject; matching email addresses never merge accounts.

OTP verification uses six digits, ten-minute expiry and three attempts. Server-side
resend and delivery limits persist in SQLite. HMAC storage derives its key from
`BETTER_AUTH_SECRET`. Existing codes require resend when that secret changes.

## Checks

```sh
pnpm --dir backend typecheck
pnpm --dir backend test
pnpm --dir backend build
pnpm --dir backend test:browser
pnpm --dir backend test:desktop
pnpm --dir backend test:native-auth
pnpm --dir backend test:package
pnpm --dir backend test:load
```

Backend tests include actual 120-second brief and 30-second advice deadlines.
Supplier fixtures are synthetic. The browser check uses real Better Auth and a local
SMTP catcher. Set `SAVVY_CHROMIUM` to an installed Chromium executable or install
Playwright Chromium. The desktop browser demo is synthetic and does not invoke
native capture or Tauri commands. Installed macOS and live provider acceptance remain
separate checks.

`test:native-auth` runs the real sign-in page with delivered local email, then hands
the callback to the Rust transport test. Rust owns PKCE and token exchange.
Tauri command dispatch handles completion, account reads, refresh, cancellation
and sign-out. The browser confirms that sign-out revokes its existing session.
The check uses Tauri MockRuntime and an isolated in-memory credential store;
macOS Keychain, native browser opening and OS deep-link delivery remain unverified. Set the low-disk Cargo profile variables used
by the repository if needed; no Stripe purchase or supplier request is performed.

## Backup and restore

Stop and drain the backend first, leaving admissions closed. With the same private
environment loaded, create a new backup directory:

```sh
pnpm --dir backend backup /path/to/new-private-backup
```

The command refuses a listening backend and locks both databases against writes
while SQLite creates consistent snapshots. It writes `auth.sqlite`, `service.sqlite`
and `manifest.json`, with integrity checks, SHA-256 hashes and public signing-key
IDs. The directory is mode 0700 and files are mode 0600. The manifest contains no
secret. Keep the matching `BETTER_AUTH_SECRET` in the separate protected secret
store. Do not copy only the main file from a live WAL database.

Restore into a fresh private state directory. Verify each snapshot's SHA-256
against the manifest, then copy the two snapshots without any unrelated WAL/SHM
files. Restore the original secret and issuer configuration separately. Point both
database environment settings at these copies, run `pnpm --dir backend migrate`,
and start one backend. Check signing-key IDs, refresh, accounts, historical balances,
usage and pending purchase IDs before reopening admissions. Reconcile payments and
usage since the backup; never erase rows to force fulfillment.

The automated restore check rotates a real Better Auth refresh token from restored
state and verifies its access token against the restored service account. It also
compares balances, usage, pending purchases and durable attempt limits.

See [`deploy/README.md`](../deploy/README.md) for the single-process deployment
layout. No production configuration, migration or deployment is performed by these
local checks.
