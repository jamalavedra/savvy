# Connected sources verification — 2026-10-18

Branch: `feature/composio-connected-sources` (based on `720ab64`); draft [PR #39](https://github.com/jamalavedra/savvy/pull/39). This is an in-progress acceptance record for the staging backend and signed `Savvy Integration.app`. All test content is fictional. Private tokens, email codes, customer mail, and audio are excluded.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Local backend suite | Pass: 115 tests, 1 opt-in live test skipped | `pnpm --dir backend test`; the new mail-scope check passed on 2026-10-18. The earlier run's private log remains in `target/connected-e2e-20261018/backend-tests.log`. |
| Local managed CRM + document + outage bridge | Pass: 1 native/backend E2E | `pnpm --dir backend test:connected-e2e` |
| React suite and TypeScript | Pass: 140 UI tests; root and backend typechecks | `vitest run`, `tsc --noEmit`, `pnpm --dir backend typecheck` |
| Rust workspace | Pass; 4 environment-dependent tests ignored | `cargo test --workspace --locked` |
| Rust lint and formatting | Pass | `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo fmt --all -- --check` |
| Backend production compilation | Pass | `pnpm --dir backend build:server` |
| PR CI | Pass on `fcdbe61`: website, Windows, Linux, and full verify, including managed browser and desktop fixtures | [PR checks](https://github.com/jamalavedra/savvy/pull/39/checks) |
| Signed staging app | Pass: Developer ID signature verified | Built at `target/release/bundle/macos/Savvy Integration.app`, installed temporarily at `/Applications/Savvy Integration.app`; `codesign --verify --deep --strict` |
| Notion live search and fetch | Pass | Search found the exact fictional Acme page; fetch returned 321 bytes with the fictional buyer and amount, and a modification time. Verified through the pinned SDK on staging on 2026-10-18. |
| Google Drive live document | A private fictional Acme pilot brief was created in the authorized Drive account and verified saved with a unique pilot city and date. The previous Composio account had only `userinfo.email openid`, so the backend correctly reported `PERMISSION_REQUIRED`. A reconnect reached Google's consent screen, which requests permission to view, edit, create, and delete every Drive file. Action-time approval is pending; the document has not been read through Composio. |
| Salesforce account, opportunity, note | Blocked: no connected staging account. The [Developer Edition signup](https://developer.salesforce.com/docs/platform/mobile-sdk/guide/dev-de.html) requires a Main Services Agreement, CAPTCHA, activation email, and password setup; these require user action at their respective prompts. |
| HubSpot company, deal, note | Blocked: no connected staging account. The free signup currently makes promotional email consent part of Continue; explicit confirmation is pending. |
| Gong call | Blocked: no test account or transcript. [Gong states it has no free trial for Engage](https://www.gong.io/ai-sales-engagement-solution/) and directs users to a demo. A Gong tenant with API read access is needed. |
| Gmail thread | A two-message fictional Acme procurement thread was sent to the authorized account itself and verified in the inbox. A Connect Link reached Google's consent screen, which requests full Gmail read, compose, send, and permanent-delete access plus contacts and personal profile fields. Action-time approval is pending; the thread has not been read through Composio. |
| Outlook thread | The authorized Microsoft account has no Outlook mailbox yet. Outlook asks to create an `@outlook.com` alias, which can be a sign-in identity and requires user handoff. Separately, the Composio consent screen requests mail send/read/write, calendar read/write, contacts read/write, mailbox settings read/write, and offline access. Action-time approval is pending; no Outlook content was read. |
| Installed browser OAuth | Blocked: staging discovery returns `sign-in discovery unavailable` on this Mac. Local IPv6 gets Cloudflare 403; IPv4 `/ready` returns 200. A temporary staging-only IPv6 allowlist request is pending. |
| Composio dashboard identity | The dedicated company alias is already registered. Cloudflare's active catch-all forwarded the login email to a different team inbox than expected; the code was found there, but the original login session had expired. A new sign-in is pending action-time confirmation of Composio's displayed terms. The existing server key remains able to perform the Notion read. |
| Installed CRM + document meeting, controlled two-channel audio, induced reconnect, and 12-minute call | Pending fresh staging OAuth and provider connections. The private 2026-10-16 run proved an installed Notion-cited answer and a synthetic public 725-second two-channel call, but did not prove this complete joined scenario. |

## Test isolation and current state

The Integration app's eight existing data files were copied and SHA-256 hashed in ignored `target/connected-e2e-20261018/`. After the blocked sign-in attempt, the original data directory was restored and all eight hashes matched; the clean test profile remains only in ignored `target/`. The temporary signed app was moved from `/Applications` to Trash; its build artifact remains available for a resumed test. No new Keychain item or recording was created. The staging test account has zero active meetings and zero reserved milliseconds. The production `/Applications/Savvy.app` and production service have not been changed. No provider token is in the repository.

The managed recommendation request uses local evidence excerpts and source IDs. The local native/backend bridge verified that changing an imported CRM or document excerpt changes the managed answer, that advice cites the local source, and that a Composio outage offers marked stale-copy or exclusion behavior without a provider call during advice. A live installed CRM-plus-document call remains the acceptance gate. The Prepare view, Settings, and privacy page now disclose the broad Google and Microsoft grants before a user connects.

The fictional Drive brief and Gmail thread are saved in the authorized test account. Their original URLs and expected text are kept only in ignored `target/connected-e2e-20261018/provider-fixtures.json`; Composio record IDs remain unset until live search succeeds.

The latest connection-status test verifies that Gmail and Outlook grants without message-body read scope show `PERMISSION_REQUIRED`, as the existing Drive check does. This prevents a partial OAuth grant from appearing ready for import.

Composio documents [managed auth scope overrides](https://docs.composio.dev/docs/authentication/controlling-scopes), but the staging project key returns HTTP 403 for `auth_configs` read access. A project administrator must supply a scoped auth config or grant the required config permission before Savvy can test narrower Gmail and Drive grants.
