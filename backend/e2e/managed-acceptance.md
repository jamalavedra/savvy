# Managed service acceptance

Record the candidate commit, desktop version, date, runtime and host for each run.
Write results to `target/managed-acceptance/report.md`: scenario, PASS/FAIL/BLOCKED,
observed result, redacted event/account IDs, timing and evidence path. Empty results
remain NOT RUN. Never include keys, OTPs, callback codes, access/refresh tokens,
private signing material, source documents or customer audio in public evidence.

## Environments and gates

- Fixtures: complete checkout; Node 22.23.2, pnpm 10.34.5, the repository Rust toolchain.
  Install all three lockfiles and Playwright Chromium before running the commands below.
  These checks use synthetic suppliers; native-auth uses MockRuntime, not Keychain.
- Hosted staging: `jaume@epistoma`, separate service/state on loopback 8789, existing
  Cloudflare Tunnel to `https://staging-api.savvycopilot.com`. Google, delivered SMTP,
  Anthropic and Deepgram must be real. Stripe and purchases must be test mode.
  No unmetered mode or development HTTP grant endpoint. Restrict the staging host
  to current test egress addresses except its signed billing webhook.
- Installed desktop: `ssh -p 2222 openfort@macbook-pro-de-openfort.tail701c62.ts.net`.
  Build the candidate using `scripts/build-integration-macos.sh` with service URL,
  issuer and audience set to the staging origin and client ID `savvy-desktop-staging`.
  Back up the production app/data. Install `Savvy Integration.app`, stop the other
  app, and register the normal OS callback handler. Keep separate integration data.
  Restore the production handler after testing. A callback file is not OS delivery.
- Production: separate user, issuer, secret, database pair and live Stripe catalog;
  port 8788 at `https://api.savvycopilot.com`. Use the signed/notarized draft candidate.
  Never inject test grants or submit an unrequested live payment. Real supplier smoke
  requires an account with legitimately funded allowance; otherwise record BLOCKED.
- Preserve the existing tunnel rules. Stage acceptance precedes production rollout;
  production smoke precedes draft publication. Do not count an ad hoc launch as
  notarized release validation or fixture load as live-provider/tunnel acceptance.

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

Use short invented source documents with a known price, a hard constraint, and a meeting objective. Generate a real Claude brief, verify grounded facts/source IDs, approve and reopen it, and observe exactly one brief debit. Cancel another generation and verify reservations release. Excluded documents must not appear in sent context.

Observed: pending. Status: NOT RUN. Evidence: pending.

### TEST-010

Run a twelve-minute two-channel meeting with distinct microphone/system utterances. Real Deepgram produces final turns attributed to the correct channel. Trigger a question, a hard-constraint conflict, and manual Advice; require valid Claude output grounded in supplied evidence/turn IDs. Pause stops streaming; resume requires an explicit action; stop releases reservations. Two simultaneous channels must charge elapsed covered time once rather than twice. Saved history survives relaunch.

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
