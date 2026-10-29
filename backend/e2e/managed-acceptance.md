# Managed service acceptance

Record the candidate commit, desktop version, date, runtime and host for each run.
The accepted desktop host is this Mac, `MacBookPro-de-jaume`, as instructed on
2026-10-11. Perform all remaining installed staging, dashboard, release and
production-client checks here. The backend remains on Epistoma. Existing local
native results count for the assertions they prove; complete their uncovered
assertions and repeat affected cases after relevant changes or failures.
Write results to `target/managed-acceptance/report.md`: scenario, PASS/FAIL/BLOCKED,
observed result, redacted event/account IDs, timing and evidence path. Empty results
remain NOT RUN. Never include keys, OTPs, callback codes, access/refresh tokens,
private signing material, source documents or customer audio in public evidence.

## Environments and gates

- Fixtures: complete checkout; Node 22.23.4, pnpm 10.34.5, the repository Rust toolchain.
  Install all three lockfiles and Playwright Chromium before running the commands below.
  These checks use synthetic suppliers; native-auth uses MockRuntime, not Keychain.
- Hosted staging: `jaume@epistoma`, separate service/state on loopback 8789, existing
  Cloudflare Tunnel to `https://staging-api.savvycopilot.com`. Google, delivered SMTP,
  Fireworks GLM-5.3 and Deepgram must be real. Stripe and purchases must be test mode.
  No unmetered mode or development HTTP grant endpoint. Restrict the staging host
  to current test egress addresses except its signed billing webhook.
  Verify local Helium uses the existing Openfort Cloudflare account owned by
  `developers@openfort.xyz` before updating access; a Bonofici-only session cannot
  administer this zone. Preserve the other tunnel routes and final catch-all.
- Installed desktop: this Mac, `MacBookPro-de-jaume`, workspace
  `/Users/jamalavedra/Projects/savvy`. Remote Mac interactive access is no longer
  required. Use local Helium/OpenCLI for Google, Stripe and Cloudflare dashboards.
  Build the candidate using `scripts/build-integration-macos.sh` with service URL,
  issuer and audience set to the staging origin and client ID `savvy-desktop-staging`.
  Back up the production app/data before replacement. Reuse a signed probe only
  when its source/hash matches the candidate; the integration build script emits
  an ad hoc bundle, so verify the final Developer ID signature separately.
  Stop other Savvy apps and verify the normal OS callback handler selects the
  exact final candidate path, not an older bundle with the same identifier.
  Privately preserve and hash the existing integration data at
  `/Users/jamalavedra/Library/Application Support/com.alamaslabs.savvy.integration`
  before launch. Use disposable invented context, recordings and history for tests.
  Restore the original data with matching hashes after normal quit.
  Restore the production handler after testing. A callback file is not OS delivery.
  After a signing-identity change, verify actual capture even if macOS permission
  switches appear enabled. Stale grants can reference an older code requirement;
  re-authorize the final signed candidate normally and relaunch before audio tests.
  Obtain action-time consent before granting microphone/system capture access.
  Verify physical microphone input separately from system playback; headphones
  playback alone does not establish working microphone capture.
- Production: separate user, issuer, secret, database pair and live Stripe catalog;
  port 8788 at `https://api.savvycopilot.com`. Run the signed/notarized draft
  production candidate on this Mac, preserving existing production app/data.
  Never inject test grants or submit an unrequested live payment. Real supplier smoke
  requires an account with legitimately funded allowance; otherwise record BLOCKED.
- Preserve the existing tunnel rules. Stage acceptance precedes production rollout;
  production smoke precedes draft publication. Do not count an ad hoc launch as
  notarized release validation or fixture load as live-provider/tunnel acceptance.
- Credential cleanup: rotate the staging Google secret that appeared in one
  diagnostic tool result. The owner performs credential rotation in Helium;
  install its replacement privately on Epistoma, verify real sign-in, then have
  the owner disable the old secret. Keep credential values and copy-button labels
  out of snapshots/logs. The full remaining task order is in
  `plan/infrastructure-managed-service-1.md`, TASK-033 through TASK-041.

## Automated checks

Run from the repository root, retain complete exit-status logs:

```sh
pnpm install --frozen-lockfile
pnpm --dir backend install --frozen-lockfile
pnpm --dir www install --frozen-lockfile
pnpm --dir backend exec playwright install chromium
pnpm verify
pnpm audit
pnpm --dir backend audit
pnpm --dir www audit
pnpm --dir backend test:browser
pnpm --dir backend test:desktop
pnpm --dir backend test:native-auth
pnpm --dir backend test:package
pnpm --dir backend test:web-return
pnpm --dir www lint
pnpm --dir www typecheck
pnpm --dir www build
pnpm --dir www exec node --test smoke.test.mjs
pnpm --dir www deploy:check
```

On Epistoma, install dependencies for Linux from the complete checkout and run
backend typecheck, tests, build, package and `test:load`. Keep fixture state isolated
from hosted state. The five-minute load must deliver all 96,000 frames with account
and auth p95 below 1,000 ms, event-loop p99 below 100 ms, queue at most 32,000 bytes.
Retain `backend/e2e/load-results.json` with hardware/runtime and commit.

## Scenarios

For every scenario, append **Observed**, **Status**, and **Evidence** to the report.
Run deterministic negative cases first; they supplement the installed journey.

### TEST-001

Run the extended HTTP boundary test. Selected CF headers work only from trusted peers; spoofed alternative headers cannot change attribution; invalid trusted values fail; two distinct visitor addresses have independent auth rate-limit buckets. Prove the same isolation through staging using two real egress addresses.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-002

Run `pnpm verify`, `pnpm --dir backend test:browser`, `test:desktop`, `test:native-auth`, `test:package`, and `test:web-return`. Every command exits zero. MockRuntime and synthetic browser results remain explicitly labeled in the report.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-003

Run `pnpm --dir www lint`, `typecheck`, `build`, `pnpm --dir www exec node --test smoke.test.mjs`, and `deploy:check`. All exit zero. Confirm the published pricing and return page match the candidate catalog.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-004

Fresh installed integration app: create an account with a delivered external OTP, cancel one attempt, reject one wrong code, resend after cooldown, and complete sign-in. Normal browser return raises the correct app and account identity is verified. New account has no paid allowance. Existing deterministic OTP tests cover expiry/attempt exhaustion.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-005

Sign in through Google with the second controlled identity. Restart the app and refresh its account using the real Keychain credential. Keep a meeting running past ten minutes in TEST-010 to prove access-token refresh/reconnect. Sign out and confirm the old refresh credential cannot be reused and the browser session is revoked.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-006

Cancel and decline Stripe test Checkout without gaining allowance. Complete a pack purchase and retry the same pending operation. Returning before fulfillment grants nothing; verified paid delivery grants exactly three hours and six briefs once. Resend the event and confirm no duplicate allowance.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-007

Complete a monthly test purchase and verify ten hours and twenty briefs with the paid-period expiry. Billing Portal cancellation changes renewal state without removing already-paid access. Exercise delayed payment/reconciliation and refund/dispute handling with actual test events; require the existing Stripe event tests to pass. For renewal, use a Stripe test clock and verify ledger period timestamps; keep backend wall-clock expiry assertions in deterministic tests rather than changing the host clock.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-008

Denied permission blocks the affected capture path with a useful recovery action. Grant permission normally. Verify microphone-only mode, microphone plus system audio, device selection, signal meters, and a separate real transcription test. Confirm meters alone never report transcription success.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-009

Use short invented source documents with a known price, a hard constraint, and a meeting objective. Generate a real Fireworks GLM-5.3 brief, verify grounded facts/source IDs, approve and reopen it, and observe exactly one brief debit. Cancel another generation and verify reservations release. Excluded documents must not appear in sent context.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-010

Run a twelve-minute two-channel meeting with distinct microphone/system utterances. Real Deepgram produces final turns attributed to the correct channel. Trigger a question, a hard-constraint conflict, and manual Advice; require valid Fireworks GLM-5.3 output grounded in supplied evidence/turn IDs. Pause stops streaming; resume requires an explicit action; stop releases reservations. Two simultaneous channels must charge elapsed covered time once rather than twice. Saved history survives relaunch.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-011

Disconnect the staging service during a live meeting and an AI request. The app shows an interruption, preserves local work, and stops paid streaming. Restart and verify reservations recover and listening stays paused until explicit resume. Use existing supplier-failure tests for deterministic outages; add one controlled staging supplier rejection and verify the same native recovery behavior before restoring valid configuration.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-012

Use a third dedicated staging account with no purchased grants. Stop staging and use the existing `insertGrant` helper from `backend/build/billing.js` to add one clearly identified `e2e-quota` pack grant with `90_000` meeting ms and one brief. Keep development-grant HTTP endpoints disabled. Restart and exercise both brief exhaustion and meeting exhaustion through the installed app. Warnings precede exhaustion; streaming stops without a negative balance. Buy a real Stripe test pack; allowance refreshes but listening resumes only after an explicit action. Record the initial entitlement as synthetic; never run this setup against production.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-013

Sign-out and service-mode changes are blocked while capture/audio checks require completion. Stop the meeting, switch to personal providers, and verify managed supplier traffic stops. Subscription status stays unchanged. Authenticate again and verify pending purchases/balances remain attached to the correct issuer/subject.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-014

Check email/sign-in, account, pricing, permission, readiness, brief review, meeting, interruption, and sign-out screens at the minimum desktop size in light/dark mode. Confirm keyboard focus, modal Escape/cancel, actionable errors, and no clipped primary actions. Verify audio/transcript retention against disposable data; do not use existing user history as fixtures.
Client removal and brief unselection must show a confirmation before mutation.
Cancel and Escape preserve stored data; explicit confirmation preserves source files.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-015

Verify systemd shutdown, restart, backup, restore, and rollback using stopped staging state. Compare signing keys, refresh rotation, grants, usage, purchases, and reservations. Restore the same matching auth secret. Rollback must preserve current financial state, not erase payments or usage made since a backup.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-016

On the signed production app, verify production DNS/TLS, issuer/audience, external sign-in, normal callback delivery, persistence across relaunch, and accurate catalog/account state. No staging credential or test grant works in production. Run funded-account real supplier smoke when that prerequisite is satisfied. Verify startup and listening with the release signing identity, not only the ad hoc identity.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-017

Verify the production backend remains loopback-only, raw Stripe signatures survive the tunnel, auth/API responses are not cached, and credentials are absent from desktop assets/logs. Check the privacy/pricing statements against observed managed data flow and retention. Confirm the release version exceeds `0.1.2`, the artifact is signed/notarized, and the published updater offers the matching new artifact. Record recovery commands and close every reported finding.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-018

On the final installed Mac and Windows 11 candidates, buy two seats through the
hosted browser using Stripe TEST mode. Invite a second verified identity, accept
after OTP and real Google redirects and a reload, and explicitly assign a seat.
Verify membership without a seat, owner without a seat, owner transfer and the
member's restricted view. On each desktop, deliberately select organization
funding, import an invented CRM record and a document into one client's folder,
start a real call, trigger advice and inspect its citation against the imported
local file. Prove the provider received the new evidence and the delivered advice
uses a unique invented fact. Inspect ledger debits on the seat assignment and
unchanged personal grants. End the call, switch to personal, repeat, and verify
only personal credit changes. Record the exact installed binary and commit.
Synthetic MockRuntime source imports are supplementary evidence only. They do not
prove OS callback delivery, Keychain/Credential Manager, physical microphone,
system loopback, real upstream model comprehension or an installed Windows flow.
Apply TEST-009/010 hardware, consent and capture gates to both call repetitions.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-019

Revoke a seated member during a real installed call and during a pending brief.
Verify upstream capture/advice stop, reservations release, confirmed usage remains
conserved, and the selected organization payer stays selected without using
personal credit. Switching is refused while a call or brief remains pending.
Sign out and relaunch as the same and a different verified identity; preferences
are separate. Retrying an already-paid unsaved brief uses its original identity
and payer without a second debit. Repeat with a Composio outage: choose a marked
stale copy or exclude it, then prove advice performs no Composio RPC and audio
usage remains billable only for delivered intervals. Idle calls and failed briefs
consume nothing. Verify cached source-count and context limits still apply.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-020

In Stripe TEST mode with the pinned API version, advance a test clock through
renewal after an owner-selected decrease from two seats to one vacant retiring
slot. Confirm there is no proration or immediate capacity reduction. Check the
organization portal prevents quantity edits. Deliberately cause external quantity
drift, reconcile, and verify canonical paid invoice quantity determines paid seat
capacity. Refund an invoice with an occupied and a vacant seat; neither retains
spendable budget. A won dispute clears only its own restriction and cannot undo a
refund or another dispute. Cancel through the portal and verify the paid window
ends without a replacement purchase before it expires. Record redacted Stripe
objects and the matching ledger conservation checks. Never run against live mode.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-021

Against stopped staging state, verify capability-1 checkpoint compatibility before
activation, then a full capability-2 release, activation and immutable checkpoint.
An old release with missing metadata and the capability-1 checkpoint must both be
refused before symlink switch or process start, including with a pending team
purchase and no grants. A complete capability-2 candidate succeeds against current
financial state. Disabling acquisition blocks new purchases/invites, preserves old
invitation acceptance and existing spending, and does not lower the floor. Check
that a lower-capability backend refuses startup. Exercise packaged commands with
production dependencies only. Preserve current financial state throughout.

Observed: pending. Status: NOT RUN. Evidence: pending.
