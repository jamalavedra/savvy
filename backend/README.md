# Savvy backend

One Node process serves Better Auth, React sign-in pages, account and billing APIs,
meeting sessions, transcription WebSockets, briefs and advice. Billing reconciliation
and session expiry run inside that process. The desktop app is Rust/Tauri and the
marketing website is statically exported.

The backend has not been deployed. [`deploy/README.md`](../deploy/README.md) lists
the acceptance checks that remain before it can be.

## Local setup

The repository pins Node 22.23.4 and pnpm 10.34.5. Build native dependencies on the
machine that will run the backend. From the repository root:

```sh
pnpm --dir backend install --frozen-lockfile
pnpm --dir backend build
```

Copy `backend/.env.example` to a private environment file, mode 0600, and fill in
its configuration. Provide a random `BETTER_AUTH_SECRET` of at least 32 characters.
Once accounts exist, keep the issuer, signing secret, client ID, resource audience
and both databases unchanged; test against copies. Create the database parent
directory before starting;
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
identity value and need not equal that URL. Do not change it once accounts exist.

For direct Cloudflare Tunnel ingress, select `SAVVY_AUTH_PROXY_IP_HEADER=cf-connecting-ip`
and trust only its exact socket peer (`SAVVY_AUTH_TRUSTED_PROXIES=127.0.0.1` on
Epistoma). The default header is `x-savvy-proxy-ip` for standalone nginx. Trusted
peers must send a single valid IP in the selected header; no alternative header
is accepted. Untrusted peers are attributed to their socket address. See the
[ingress setup](../deploy/README.md#ingress-and-configuration) before exposing it.

`SAVVY_AUTH_DATABASE` contains users, sessions, OAuth grants and encrypted signing
keys. `SAVVY_DB_PATH` contains the billing ledger, subscriptions, purchases and
usage. They must be distinct files, and only one backend process may open them.

Configure SMTP and a Google OAuth web client with `/api/auth/callback/google` on
`BETTER_AUTH_URL`. Google receives identity scopes only. SMTP outside loopback
requires TLS. A local mail catcher on port 1025 supports manual tests; automated
checks start their own SMTP catcher. `GET /ready` confirms the auth database answers a
`jwks` query and reports whether Google, SMTP and Stripe are configured. `GET /readyz` checks both databases and fails during drain. Neither
endpoint proves external suppliers are working.

For managed GLM-5.3, set `SAVVY_FIREWORKS_API_KEY`,
`SAVVY_AI_MODEL=accounts/fireworks/models/glm-5p3`, and
`SAVVY_FIREWORKS_BASE_URL=https://api.fireworks.ai/inference`. This uses standard
serverless Messages with schema output and the model's required thinking enabled.
Its byte-level BPE lets the shared input check conservatively bound tokens using
serialized UTF-8 bytes plus 4096 tokens of template overhead. Some inputs below
the real token limit will be rejected; required context is never trimmed. Briefs,
meeting readiness and advice retain their respective 120k/16k/24k limits. Usage
includes cached input, and costs use the standard GLM-5.3 rates. Other Fireworks
models require verification before configuration. An empty Fireworks key retains
the Anthropic variables and Claude path.

Set `COMPOSIO_API_KEY` to enable connected sources for signed-in managed users.
Savvy stores one toolkit-limited Composio session per internal account and allows
Salesforce, HubSpot, Gmail, Outlook, Notion, and Google Drive. Gong connection and
read endpoints are disabled until its live acceptance is complete; an existing
Gong connection can still be disconnected. Search and
fetch requests are rate limited per account. The backend keeps the Composio key;
selected record text returns to the desktop for a local Markdown copy. The
Composio project API key must permit session creation and proxy execution.
Composio disables proxy execution when a session has a tool allowlist, so
Savvy enforces read-only access through its fixed authenticated search/fetch
routes. Some provider OAuth grants can still give Composio broader rights.
For Google Drive, a grant containing only identity scope reports
`PERMISSION_REQUIRED` and can be reconnected; listing files needs a Drive
read scope.

Composio user IDs include a SHA-256 digest of the backend's exact stable issuer
and the internal account ID. The session cache records that identity and never
reuses a legacy or different-issuer session. Staging and production therefore
cannot share connected apps when their numeric account IDs overlap, even within
the same Composio project. Preserve the issuer across upgrades. Legacy `savvy:4`
connections remain in Composio untouched; reconnect them under the new staging
identity before repeating connected-source acceptance. Their local Markdown files
and client selections are not deleted by this migration.

The native client uses `com.alamaslabs.savvy:/oauth/callback`, authorization code
with S256 PKCE, RS256 access tokens and rotating refresh tokens. Dynamic OAuth client
registration is closed; any email address can create an account from the sign-in page. Auth migrations keep the registered client and resource rows. Billing identity remains
verified issuer plus subject; matching email addresses never merge accounts.

OTP verification uses six digits, ten-minute expiry and three attempts. Server-side
resend and delivery limits persist in SQLite. HMAC storage derives its key from
`BETTER_AUTH_SECRET`. Existing codes require resend when that secret changes.

## Billing

The four `SAVVY_STRIPE_*` selector and secret variables are optional. When all four
are empty, the backend runs unmetered: billing routes return `invalid_request`, and
each account receives one allowance of 1,000,000 hours and 1,000,000 briefs.
A non-loopback `BETTER_AUTH_URL` or `SAVVY_HOST` refuses to start unmetered unless
`SAVVY_ALLOW_UNMETERED=1` is set. Setting only some of the four variables fails at
startup. `GET /ready` reports `billing` as `stripe` or `unmetered`. When Stripe is
configured again, startup revokes every unmetered grant. Removing it again restores them.

## Checks

```sh
pnpm --dir backend typecheck
pnpm --dir backend test
pnpm --dir backend build
pnpm --dir backend test:browser
pnpm --dir backend test:desktop
pnpm --dir backend test:connected-e2e
pnpm --dir backend test:connected-live
pnpm --dir backend test:native-auth
pnpm --dir backend test:package
pnpm --dir backend test:web-return
pnpm --dir backend test:load
```

Backend tests include actual 120-second brief and 30-second advice deadlines.
Supplier fixtures are synthetic. The browser check uses real Better Auth and a local
SMTP catcher. Set `SAVVY_CHROMIUM` to an installed Chromium executable or install
Playwright Chromium. The desktop browser demo is synthetic and does not invoke
native capture or Tauri commands. Installed macOS and live provider acceptance remain
separate checks.

`test:connected-e2e` runs synthetic Composio and AI suppliers through the real
backend HTTP routes and the native source commands. It saves CRM and Drive copies,
scans the client folder, starts a managed backend session, and verifies advice
citations. It repeats the meeting with Composio unavailable, checking both stale
and excluded local snapshots. Live app permissions and provider accounts remain
separate acceptance checks.
Set `SAVVY_CONNECTED_E2E_MODEL=1` when an authenticated Codex CLI is available
to also send the imported evidence and a simulated call turn through Savvy's
native advice prompt, then change the CRM price and verify the advice changes
with it while citing the CRM source. The managed AI
supplier remains synthetic in this fixture.

For the live Notion acceptance test, connect the dedicated account to a
fictional page titled `Savvy connector test — Acme renewal` containing
`Maya Chen` and `24000`. From `backend/`, run
`SAVVY_CONNECTED_E2E_LIVE_NOTION=1 SAVVY_CONNECTED_E2E_MODEL=1 node --env-file=.env.connected-live --test --import tsx --test-name-pattern='live Notion record' src/ai.test.ts`.
This uses the real Composio page and Codex CLI, imports it through the native
source commands, builds a call recommendation from a transcript turn, checks
the answer changes when the buyer changes, passes that real advice through the
managed backend contract, and repeats refresh with a simulated Composio outage.
It does not capture live microphone audio or call the managed AI supplier.

`node e2e/connected-staging.mjs` is the opt-in hosted call check. Set
`SAVVY_E2E_TOKEN_FILE`, `SAVVY_E2E_OAUTH_FILE`, `SAVVY_E2E_MIC_PCM`, and
`SAVVY_E2E_SYSTEM_PCM` to private test files; the PCM inputs must be invented
16 kHz mono signed 16-bit speech. A dedicated staging account needs meeting
allowance and the fictional Notion page connected. The script refreshes the
account token, fetches the live page through Savvy, streams both audio channels
through Deepgram, and requires managed advice to cite the page and name its buyer.
It defaults to a 725-second meeting with a mid-call token rotation and explicit
pause/resume; set `SAVVY_E2E_DURATION_MS=45000` for a short smoke. It exercises
hosted audio transport, not installed Mac microphone or system capture. Set
`SAVVY_E2E_NATIVE_FILE` to the private JSON output of the
`connected_source_e2e_bridge` Rust test to require the real local source copy and
scanner evidence in the hosted recommendation.
Set `SAVVY_E2E_ALLOW_RECONNECT=1` to exercise the managed stream's 15-second
reconnect path after a public transport interruption; the result reports the
number of reconnects. Leave it unset when checking uninterrupted transport.

For live adapter acceptance, connect all six released providers to a dedicated Savvy test
account through Settings. Copy `e2e/connected-live.example.json` outside the repo,
set its issuer to the backend's exact `BETTER_AUTH_URL`, replace the account ID
with that account's stable internal numeric ID, and enter one
known, searchable record per kind. Set `COMPOSIO_API_KEY` and
`SAVVY_CONNECTED_LIVE_FIXTURE` to the private fixture path, then run
`test:connected-live`. It checks account status, search and fetch for all 10 released kinds,
including source URL, modification time, expected text and size. It prints only case
names and pass/fail status; keep the fixture and key outside version control.

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
layout. These local checks do not touch any production configuration or data.

## Organization seats

`/team` and `/team/join` are part of the same hosted bundle and origin as sign-in.
No new environment variables or Better Auth organization plugin are required.
The service database owns membership, stable seats, assignment history, invoice
periods and grants. Better Auth owns identity. One owner manages up to 50 seats;
an owner need not occupy one. Each seat uses the existing monthly catalog Price
and its per-person allowance. Quantity changes apply at the next paid renewal,
without proration. Decreases require vacant seats selected for retirement.

`GET /v1/org` works for a verified browser cookie or desktop bearer token. The
following POST routes accept JSON: `/v1/org` to create, `/v1/org/checkout`,
`/v1/org/seats` to schedule quantity, `/v1/org/portal`, `/v1/org/invitations`,
`/v1/org/invitations/{id}/revoke`, `/v1/org/invitations/{id}/resend`,
`/v1/org/invitations/accept`, `/v1/org/seats/{id}/assign`,
`/v1/org/seats/{id}/unassign`, `/v1/org/members/{id}/remove`,
`/v1/org/transfer-owner`, and `/v1/org/leave`. Cookie writes require the exact
configured Origin and `application/json`. An invalid bearer header never falls
back to a cookie. Ownership and membership are rechecked inside write transactions.

Invitations use the existing SMTP transport after the database commit. A link
carries its random token in `/team/join#token`; only its hash is stored. Tokens
expire after seven days and require the invited verified email. At most 50 open
invitations are allowed. Resending rotates the token. Failed mail is visible and
does not erase the invitation. Acceptance creates membership even when no paid
seat is vacant. Owner responses contain membership and aggregate usage only.

New desktop requests send `funding: {kind:"personal"}` or
`funding: {kind:"organization", organizationId:"<decimal id>"}` when creating a
session or brief. Omitted funding is personal only. The backend freezes the
resolved assignment on the operation and checks it before spending. Personal
account totals exclude seat grants; `/v1/account` adds `organization` and
`organizationAllowance`. Advice and audio inherit the session's payer. Seat loss,
exhaustion, refund or dispute never causes fallback to another allowance. Any
partial refund invalidates that invoice's whole seat budget. A won dispute cannot
undo a refund or another open dispute. Reassignment transfers only the unspent
remainder, without transferring personal data or creating fresh allowance.

New desktop preferences are stored per verified issuer and subject. Paid pending
brief files include their original identity and funding choice. A different payer
cannot silently recover them as a new request. Legacy managed pending files
without this metadata remain preserved and require explicit local recovery;
they are not regenerated or charged automatically.

Acquisition defaults off. The packaged `capability` command supports `show`,
`disable-team-purchases`, and `activate-team-purchases`; each requires
`--db <existing service.sqlite>`. Activation also requires
`--checkpoint-commit <40-character sha>` and
`--checkpoint-manifest <built service-capabilities.json>`. Stop the service first.
The source manifest remains capability 1 until complete-release acceptance.
Activation requires capability 2, records an immutable compatible checkpoint and
permanent database floor before payment creation, and cannot be reversed by
turning acquisition off. Disabled acquisition blocks new organizations, checkouts
and invitation sends, while existing invitations, entitlements, renewals,
reconciliation, revocations and administration continue.

Run `pnpm rollback-preflight --db <existing service.sqlite> --candidate
<candidate/backend/build/service-capabilities.json>` from the current backend
package before switching releases. Missing metadata means capability 0. The CLI
reads the existing database without migrations and rejects incompatible releases.
See the deployment guide for the guarded atomic switch and activation gates.
