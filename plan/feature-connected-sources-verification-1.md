---
goal: Verify Composio connected sources and the installed managed meeting before review
version: 1.0
date_created: 2026-10-18
last_updated: 2026-10-18
owner: Savvy
status: 'In progress'
tags: [feature, verification, composio, desktop]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In_progress-yellow)

Complete the checks left open by the 2026-10-16 connected-source run. Use fictional Acme records. Keep credentials and captured audio out of the repository and PR. Record each result in `docs/verification/connected-sources-2026-10.md`.

## 1. Requirements & Constraints

- **REQ-001**: Search and fetch one live record for every supported provider and kind in `backend/src/composio.live.ts`: Salesforce account, opportunity, note; HubSpot company, deal, note; Gong call; Gmail thread; Outlook thread; Notion page; Google Drive document.
- **REQ-002**: Complete installed macOS sign-in through the browser callback. No token injection may count as this check.
- **REQ-003**: In an installed managed meeting, verify an imported source changes an answer and the citation opens the matching local Markdown file.
- **REQ-004**: Verify controlled microphone speech and system playback on separate channels, an abnormal audio disconnect and automatic reconnect, and a call longer than the earlier failure points.
- **REQ-005**: Verify failed refresh presents stale-copy and exclude choices, neither choice calls Composio during advice, and both allow the meeting to proceed.
- **REQ-006**: Run the backend, UI, Rust, formatting, and source-adapter checks. Resolve the local `ai.test.ts` runner stall or capture a clean equivalent run on the staging Linux host.
- **REQ-007**: Open a PR from a feature branch containing code, tests, this plan, and a redacted verification report. Exclude `target/`, tokens, recordings, and `findings/`.
- **SEC-001**: Use a dedicated staging Savvy account and fictional provider records. Keep provider tokens on the staging server. Restore local app data and temporary access settings after tests.
- **CON-001**: Production and existing real customer data remain untouched. Do not accept provider terms, grant new sensitive permissions, or change security rules through a computer UI without the required action-time confirmation.
- **CON-002**: Do not run microphone or system capture while an unrelated conversation is audible on the Mac. Use a controlled fixture or a quiet test window.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Re-establish a clean test environment and baseline.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create branch `feature/composio-connected-sources` from current `main` without discarding the existing feature changes. Inventory tracked and untracked files with `git status --short`; exclude pre-existing `findings/`. | ✅ | 2026-10-18 |
| TASK-002 | Renew the dedicated staging account login through the installed browser OAuth flow in `src-tauri/src/managed.rs`; assert that the callback returns to the exact signed staging app and `/v1/account` succeeds. | | |
| TASK-003 | Build a signed staging app with `scripts/build-integration-macos.sh`. Back up and hash the Integration app data, then use a disposable client folder under `target/`. Record signature, bundle path, and source revision. | ✅ | 2026-10-18 |

### Implementation Phase 2

- GOAL-002: Verify every live Composio adapter and local import behavior.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Establish one staging connection for each of the seven `PROVIDERS` in `backend/src/composio.ts`, using authorized test accounts. Record connected account IDs only in the private fixture. | | |
| TASK-005 | Create fictional Acme records for the 11 kinds in `backend/e2e/connected-live.example.json`. Save only record IDs and non-sensitive expected text in a private fixture, then run `backend/src/composio.live.ts` and require 11/11 search-and-fetch passes. | | |
| TASK-006 | In `src/ConnectedSources.tsx` and `src-tauri/src/lib.rs`, attach a CRM record and a document to one disposable client. Refresh, inspect exact Markdown content and citation identity, edit one local file, refresh again, and verify the edit is preserved with a visible conflict. | | |
| TASK-007 | Simulate a Composio outage before meeting start. Verify the stale-copy and exclude choices separately in the installed app and in `backend/e2e/connected-staging.mjs`; inspect the frozen evidence set for each choice. | | |

### Implementation Phase 3

- GOAL-003: Verify the installed call and audio recovery.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | With unrelated calls closed, speak a controlled microphone phrase and play a distinct system-audio phrase. Require separate final transcript turns and correct source labels in the installed overlay. | | |
| TASK-009 | Ask a question whose answer exists only in the imported fictional record. Require an answer with the correct fact and a citation to the exact local imported file; inspect the advice request to confirm it carries source excerpts and no Composio tools. | | |
| TASK-010 | Induce an abnormal client WebSocket close during a staging meeting. Require reconnection under the same lease, no service pause, and no usage debit during the gap. Repeat a managed call longer than 12 minutes through the public staging path with microphone and system audio. | | |

### Implementation Phase 4

- GOAL-004: Complete regression, cleanup, and review.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-011 | Run backend full tests and typecheck, React tests, Rust workspace tests, and Prettier. Fix failures or document a specific external blocker with a reproducible command and equivalent clean run. | ✅ | 2026-10-18 |
| TASK-012 | Restore original local app data byte for byte. Remove the test app, test Keychain item, disposable recordings, and any temporary staging firewall entry. Verify staging session state is stopped with zero reservation. | | |
| TASK-013 | Write `docs/verification/connected-sources-2026-10.md` with a result for each task, safe evidence references, exact limitations, and no secrets or real conversation. Commit the feature on the branch and open a PR against `main` with that report linked. | | |

## 3. Alternatives

- **ALT-001**: Mocking all providers is insufficient because provider scopes and tool response shapes caused the remaining uncertainty.
- **ALT-002**: Injecting a refresh token into Keychain does not verify browser OAuth or callback delivery.

## 4. Dependencies

- **DEP-001**: The existing staging Composio API key and managed backend on Epistoma.
- **DEP-002**: Test accounts with read permission for each provider; Gong or Salesforce may require a trial, organizational approval, or a paid account.
- **DEP-003**: A quiet Mac test window and microphone and system audio permissions for the signed staging app.

## 5. Files

- **FILE-001**: `backend/src/composio.ts`, `backend/src/composio.test.ts`, and `backend/src/composio.live.ts` hold adapters and their checks.
- **FILE-002**: `backend/src/sessions.ts`, `backend/src/transcription.ts`, and their tests hold reconnect behavior.
- **FILE-003**: `src/ConnectedSources.tsx`, `src-tauri/src/lib.rs`, and `src-tauri/src/managed.rs` hold desktop import, meeting, and sign-in behavior.
- **FILE-004**: `docs/verification/connected-sources-2026-10.md` records redacted results and remaining limits.

## 6. Testing

- **TEST-001**: `backend/src/composio.live.ts` must pass all 11 live provider and kind fixtures.
- **TEST-002**: `backend/src/transcription.test.ts` must prove abnormal-close reconnect; the installed call must also survive an induced disconnect.
- **TEST-003**: A real installed meeting must produce separate microphone and system transcript turns, cite the imported local file, and run longer than 12 minutes without an unhandled pause.
- **TEST-004**: The full backend, React, and Rust suites plus typecheck and formatting must pass for the candidate branch.

## 7. Risks & Assumptions

- **RISK-001**: Some sales providers may not offer self-serve test accounts or required scopes. Record the exact provider gate and stop that specific account action before accepting legal terms or paying.
- **RISK-002**: A clean long call does not prove every network fault is repaired; the induced disconnect must exercise the reconnect path.
- **ASSUMPTION-001**: The user's authorization covers creating fictional records and test accounts with the authorized test identity, subject to action-time browser confirmations.

## 8. Related Specifications / Further Reading

- [Previous private E2E report](../target/connected-e2e-20261016/report.md)
- [Managed acceptance protocol](../backend/e2e/managed-acceptance.md)
