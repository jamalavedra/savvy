---
goal: Apply shipped Handy reliability improvements that fit Savvy
version: 1
date_created: 2026-09-05
last_updated: 2026-09-05
owner: Savvy maintainers
status: Completed
tags: [upgrade, reliability, upstream-review]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Review baseline: Savvy `02bad43`; Handy releases v0.9.0 through v0.9.6, July 1 through August 24, 2026. GitHub reports v0.9.6 as the latest stable release. Savvy has its own initial public commit and crate structure, with no Handy remote or shared fork point available locally. Adapt the behavior to Savvy rather than cherry-picking Handy's files.

Handy's `main` was 12 commits ahead of v0.9.6 at review time, ending at `bc7facea3a777869182203cfcf5c90f7a98efd99`. Those commits, including tail-audio handling, experimental VAD, log redaction, and automatic push-to-talk, are unreleased and excluded from the shipped-change scope.

## 1. Requirements and constraints

- REQ-001: Keep correctly typed stored settings when another field has a bad type. Preserve legacy onboarding and AssemblyAI migrations.
- REQ-002: Synchronize saved settings across webviews and apply the native theme at startup and after changes.
- REQ-003: Unmount the idle overlay. Bound microphone polling to one pending request and stop on pause, hidden documents, or unmount.
- REQ-004: Fall back to the default input only when a selected microphone is confirmed absent. Preserve output-device selection semantics and do not mask enumeration failures.
- REQ-005: Run meeting capture operations on blocking workers, serialize lifecycle transitions, and keep UI meter reads from waiting on device locks.
- SEC-001: Do not log setting values or audio. Do not bypass validation for settings writes. Preserve private file modes and completed audio.
- CON-001: Keep hosted streaming transcription, source-grounded recommendations, macOS support, and current dependencies.
- CON-002: Do not switch devices within an existing WAV recording. Different hardware formats require segmented recordings or a continuous format conversion design first.

## 2. Implementation steps

### Implementation phase 1

- GOAL-001: Complete the shipped-change fit assessment. Completion: each release entry has a decision in the review table below.

| Task     | Description                                                                                                                                                   | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | Inspect all v0.9 release notes and the implementation diffs for audio, settings, overlay, tray, and login-item candidates. Record source links and decisions. | Yes       | 2026-09-05 |

### Implementation phase 2

- GOAL-002: Apply compatible reliability fixes. Depends on Phase 1. Completion: regression checks pass for each changed behavior.

| Task     | Description                                                                                                                                                                   | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-002 | In `src-tauri/src/settings.rs::load`, recover independently deserializable fields from object-shaped JSON, then apply existing migrations.                                    | Yes       | 2026-09-05 |
| TASK-003 | In `src-tauri/src/lib.rs`, broadcast committed settings and apply native theme; in `src/App.tsx`, subscribe to settings and capture-error events.                             | Yes       | 2026-09-05 |
| TASK-004 | In `src/App.tsx`, unmount idle `MeetingOverlay` and replace overlapping meter intervals with a cancellable, visibility-aware poll.                                            | Yes       | 2026-09-05 |
| TASK-005 | In `crates/audio/src/lib.rs`, use default microphone when the saved input is absent and report failed capture through meter health; document fallback and Bluetooth behavior. | Yes       | 2026-09-05 |
| TASK-006 | In `src-tauri/src/lib.rs`, dispatch start/pause/resume/stop and settings work to blocking workers, serialize meeting transitions, and use nonblocking meter lock acquisition. | Yes       | 2026-09-05 |

### Implementation phase 3

- GOAL-003: Verify and record results. Depends on Phase 2. Completion: repository verification passes, with physical hardware checks explicitly separated.

| Task     | Description                                                                                                                                        | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-007 | Add regression tests to existing Rust and frontend suites; run `cargo fmt --all --check` and `pnpm verify`. Record results and manual checks here. | Yes       | 2026-09-05 |

### Update and onboarding follow-up

- GOAL-004: Fix the user-reported return to setup after updating. See the [investigation and evidence](../docs/update-permissions-investigation.md).

| Task     | Description                                                                                                                                                                                                                     | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-008 | Compare actual v0.1.0 and v0.1.1 release signatures, trace Tauri restart and permission checks, and distinguish confirmed causes from inference.                                                                                | Yes       | 2026-09-05 |
| TASK-009 | In `src/App.tsx`, remove the completed-user startup permission gate. Keep microphone enforcement at meeting start.                                                                                                              | Yes       | 2026-09-05 |
| TASK-010 | Add `src-tauri/src/relaunch.rs`; route updates and explicit permission recovery through Launch Services after process exit. Block restarting during meetings and show failures.                                                 | Yes       | 2026-09-05 |
| TASK-011 | Add an explicit ScreenCaptureKit recheck through `crates/audio/src/lib.rs`, `src-tauri/src/lib.rs`, and `src/lib/api.ts`; expose recheck/reopen recovery in `src/Onboarding.tsx` with regressions in `src/Onboarding.test.tsx`. | Yes       | 2026-09-05 |

## 3. Alternatives

- ALT-001: Direct upstream merge. Rejected because Savvy's hosted transcription, meeting records, recommendation providers, and UI use different implementations.
- ALT-002: Local streaming model migration from Handy #1529/#1924. Defer to a dedicated offline transcription project with model downloads, packaging, language coverage, and two-stream performance evaluation.
- ALT-003: Mid-meeting device recovery from #1838/#1874. Adapt health reporting and next-recording fallback now. Defer automatic switching until the recording format can change without invalidating the current WAV.
- ALT-004: SMAppService from #1825. Defer. Launch at login already works through Tauri; changing registration requires migration and signed installed-app verification. The upstream benefit is app attribution in Login Items.
- ALT-005: New tray state engine from #1952. Skip. Savvy uses one static template image and does not have Handy's competing model/recording/theme icon writers.
- ALT-006: FFT meter calibration from #1813/#1491. Skip the constants. Savvy measures RMS and already scales its display, so Handy's per-bin FFT correction is not applicable.

## 4. Dependencies

- DEP-001: Existing serde_json, CPAL, Tauri, React, and Vitest. No added package dependencies.
- DEP-002: Existing pinned Rust toolchain and pnpm lockfile, with macOS and Xcode command-line tools for native compilation.

## 5. Files

- FILE-001: `src-tauri/src/settings.rs`, settings salvage and regression test.
- FILE-002: `src-tauri/src/lib.rs`, settings events, native theme, worker dispatch, and capture health.
- FILE-003: `crates/audio/src/lib.rs`, microphone fallback and capture errors.
- FILE-004: `src/App.tsx` and `src/App.test.tsx`, settings subscription, overlay lifecycle, polling, and regression checks.
- FILE-005: `README.md`, microphone fallback and Bluetooth guidance.
- FILE-006: This plan, upstream decisions and verification record.
- FILE-007: `src-tauri/src/relaunch.rs`, `src/Onboarding.tsx`, `src/Onboarding.test.tsx`, and `src/lib/api.ts`, update/permission recovery.
- FILE-008: `docs/update-permissions-investigation.md`, incident investigation, artifact verification, and limits.
- FILE-009: `src-tauri/src/tray.rs`, route quit through worker-thread cleanup.
- FILE-010: App manifests and `Cargo.lock`, patch version 0.1.2. Browser preview reads the package version.
- FILE-011: `CONTRIBUTING.md` and the local install script, correct outdated platform and updater comments.

## 6. Testing

- TEST-001: Invalid field types must not reset the microphone, theme, onboarding, or custom prompt. Non-object JSON retains fresh defaults. Legacy migrations still run.
- TEST-002: Device resolution prefers a present selected device, falls back only for missing input, and reports missing output or default devices.
- TEST-003: Idle overlay has no animated card. Polling stops on pause/unmount/hidden documents, handles rejection, and never overlaps slow requests.
- TEST-004: A saved settings event updates the overlay theme and display settings without relaunching.
- TEST-005: Run `pnpm verify` and Rust formatting; inspect the final diff for unrelated edits.
- TEST-006: Manual installed-app checks: unplug selected USB/Bluetooth input before starting; disconnect during recording and verify an actionable error; stop and start again; toggle Light/Dark/System; confirm responsive start/pause/stop and intact audio; quit while settings are saving. Automated tests do not establish these hardware results.

## 7. Risks and assumptions

- RISK-001: Automatic fallback can select a different microphone than expected. Preserve the preferred device for when it reconnects and document that fallback is per recording.
- RISK-002: Settings recovery salvages structurally valid JSON objects; it cannot reconstruct truncated JSON. Existing write validation remains authoritative for new settings.
- RISK-003: Native device and window behavior requires physical macOS testing beyond unit tests and builds.
- ASSUMPTION-001: The repository's product name is Savvy, referred to as SAVI in the request. Preserve existing branding.
- ASSUMPTION-002: Recent shipped improvements means the complete v0.9 release series. Older v0.8.3 was checked as context, not treated as newly shipped.

## 8. Sources

- [Handy releases](https://github.com/cjpais/Handy/releases)
- [Latest stable v0.9.6](https://github.com/cjpais/Handy/releases/tag/v0.9.6)
- [Settings salvage](https://github.com/cjpais/Handy/pull/1631)
- [Theme propagation](https://github.com/cjpais/Handy/pull/1659)
- [Hidden overlay rendering](https://github.com/cjpais/Handy/pull/1445)
- [Microphone fallback](https://github.com/cjpais/Handy/pull/1874)
- [Blocking audio work](https://github.com/cjpais/Handy/pull/1716)
- [Contribution and verification rules](../CONTRIBUTING.md)

### Shipped-change review

Every one of the 116 PR entries in the seven v0.9 release notes is accounted for below. Grouped rows contain changes sharing the same applicability decision. Detailed patches were inspected for the audio, settings, overlay, tray, and login-item candidates. Platform/model-only changes were assessed against Savvy's dependencies and feature set.

<!-- prettier-ignore -->
| Upstream PRs | Decision | Savvy assessment |
| --- | --- | --- |
| [#1631](https://github.com/cjpais/Handy/pull/1631) | Apply | Recover valid settings fields. Savvy already defaults missing fields but reset everything on one wrongly typed field. |
| [#1659](https://github.com/cjpais/Handy/pull/1659) | Apply | Broadcast saved settings to all webviews and apply native Light/Dark/System appearance. |
| [#1445](https://github.com/cjpais/Handy/pull/1445) | Apply | Unmount the idle overlay; pause microphone polling for hidden documents. |
| [#1716](https://github.com/cjpais/Handy/pull/1716) | Apply | Device enumeration already uses workers. Move meeting lifecycle and settings operations to workers too; serialize transitions and avoid blocking meter reads. |
| [#1874](https://github.com/cjpais/Handy/pull/1874), [#1838](https://github.com/cjpais/Handy/pull/1838) | Adapt | Use the system default at the next recording if the selected input is missing. Surface capture failure; keep existing audio. Automatic mid-recording switching is deferred because WAV format is fixed. |
| [#1886](https://github.com/cjpais/Handy/pull/1886) | Apply documentation | Explain Bluetooth microphone/playback quality and selecting a separate input. |
| [#1810](https://github.com/cjpais/Handy/pull/1810) | Already present | Overlay show and resize dispatch to the main thread in src-tauri/src/overlay.rs. Tauri handles hide through its window API. |
| [#1254](https://github.com/cjpais/Handy/pull/1254) | Already present | selectedChannel exists in settings, UI, capture, and channel-extraction tests. |
| [#1599](https://github.com/cjpais/Handy/pull/1599) | Already present | Light/Dark/System selector and shared CSS exist. Cross-window propagation is handled above. |
| [#1310](https://github.com/cjpais/Handy/pull/1310) | Already present | Brief generation and recommendations explicitly treat source text and CONTEXT_JSON as untrusted data; structured results validate evidence references. |
| [#1537](https://github.com/cjpais/Handy/pull/1537) | Already present | Transcription parsers discard empty turns. Do not suppress manually requested advice based on transcript emptiness. |
| [#1444](https://github.com/cjpais/Handy/pull/1444), [#1447](https://github.com/cjpais/Handy/pull/1447) | Already present, strengthen | Savvy polls scalar RMS levels instead of pushing audio-callback events to every webview. Bound requests and handle failures in the overlay. |
| [#1811](https://github.com/cjpais/Handy/pull/1811) | Already present | set_shortcut_recording unregisters the active shortcut while editing it. |
| [#1908](https://github.com/cjpais/Handy/pull/1908), [#1924](https://github.com/cjpais/Handy/pull/1924), [#1773](https://github.com/cjpais/Handy/pull/1773), [#1668](https://github.com/cjpais/Handy/pull/1668), [#1846](https://github.com/cjpais/Handy/pull/1846), [#1815](https://github.com/cjpais/Handy/pull/1815), [#1731](https://github.com/cjpais/Handy/pull/1731), [#1678](https://github.com/cjpais/Handy/pull/1678), [#1685](https://github.com/cjpais/Handy/pull/1685), [#1662](https://github.com/cjpais/Handy/pull/1662), [#1648](https://github.com/cjpais/Handy/pull/1648), [#1653](https://github.com/cjpais/Handy/pull/1653), [#1664](https://github.com/cjpais/Handy/pull/1664), [#1589](https://github.com/cjpais/Handy/pull/1589), [#1602](https://github.com/cjpais/Handy/pull/1602), [#1603](https://github.com/cjpais/Handy/pull/1603), [#1613](https://github.com/cjpais/Handy/pull/1613), [#1634](https://github.com/cjpais/Handy/pull/1634), [#1484](https://github.com/cjpais/Handy/pull/1484), [#1541](https://github.com/cjpais/Handy/pull/1541), [#1529](https://github.com/cjpais/Handy/pull/1529), [#1522](https://github.com/cjpais/Handy/pull/1522), [#1187](https://github.com/cjpais/Handy/pull/1187) | Defer local model project | These changes concern local inference engines, their models, model downloads, GPU selection, packaging, native model paths, or inference diagnostics. Savvy streams audio to Deepgram/AssemblyAI and has no corresponding model manager. |
| [#1738](https://github.com/cjpais/Handy/pull/1738), [#1911](https://github.com/cjpais/Handy/pull/1911), [#1406](https://github.com/cjpais/Handy/pull/1406), [#1231](https://github.com/cjpais/Handy/pull/1231), [#1760](https://github.com/cjpais/Handy/pull/1760), [#1785](https://github.com/cjpais/Handy/pull/1785), [#1809](https://github.com/cjpais/Handy/pull/1809), [#1812](https://github.com/cjpais/Handy/pull/1812), [#1847](https://github.com/cjpais/Handy/pull/1847), [#1569](https://github.com/cjpais/Handy/pull/1569), [#1623](https://github.com/cjpais/Handy/pull/1623), [#1465](https://github.com/cjpais/Handy/pull/1465), [#1605](https://github.com/cjpais/Handy/pull/1605), [#1926](https://github.com/cjpais/Handy/pull/1926), [#1708](https://github.com/cjpais/Handy/pull/1708) | Skip dictation-specific behavior | Savvy does not paste text, alter the clipboard, mute system output, run Handy post-processing HTTP requests, correct custom dictation words, use Handy Keys, or provide push-to-talk. Muting system output would impair hearing the meeting. |
| [#1866](https://github.com/cjpais/Handy/pull/1866), [#1756](https://github.com/cjpais/Handy/pull/1756), [#1412](https://github.com/cjpais/Handy/pull/1412), [#1700](https://github.com/cjpais/Handy/pull/1700), [#1892](https://github.com/cjpais/Handy/pull/1892), [#369](https://github.com/cjpais/Handy/pull/369), [#1733](https://github.com/cjpais/Handy/pull/1733), [#1778](https://github.com/cjpais/Handy/pull/1778), [#1824](https://github.com/cjpais/Handy/pull/1824), [#1561](https://github.com/cjpais/Handy/pull/1561), [#1753](https://github.com/cjpais/Handy/pull/1753), [#1237](https://github.com/cjpais/Handy/pull/1237), [#1308](https://github.com/cjpais/Handy/pull/1308), [#1487](https://github.com/cjpais/Handy/pull/1487), [#1867](https://github.com/cjpais/Handy/pull/1867), [#1727](https://github.com/cjpais/Handy/pull/1727), [#1732](https://github.com/cjpais/Handy/pull/1732), [#1577](https://github.com/cjpais/Handy/pull/1577), [#1621](https://github.com/cjpais/Handy/pull/1621), [#1636](https://github.com/cjpais/Handy/pull/1636), [#1335](https://github.com/cjpais/Handy/pull/1335), [#1392](https://github.com/cjpais/Handy/pull/1392), [#1426](https://github.com/cjpais/Handy/pull/1426) | Skip unsupported platform paths | Linux/Wayland/Nix, Windows, or portable-installer implementation. Savvy ships macOS Apple Silicon and has different CI and packaging. |
| [#1881](https://github.com/cjpais/Handy/pull/1881), [#1907](https://github.com/cjpais/Handy/pull/1907), [#1747](https://github.com/cjpais/Handy/pull/1747), [#1795](https://github.com/cjpais/Handy/pull/1795), [#1798](https://github.com/cjpais/Handy/pull/1798), [#1697](https://github.com/cjpais/Handy/pull/1697), [#1701](https://github.com/cjpais/Handy/pull/1701), [#1709](https://github.com/cjpais/Handy/pull/1709), [#1590](https://github.com/cjpais/Handy/pull/1590), [#1593](https://github.com/cjpais/Handy/pull/1593), [#1594](https://github.com/cjpais/Handy/pull/1594), [#1604](https://github.com/cjpais/Handy/pull/1604), [#1632](https://github.com/cjpais/Handy/pull/1632), [#1422](https://github.com/cjpais/Handy/pull/1422) | Defer localization project | Handy translation dictionaries cannot be imported into Savvy, whose UI and strings differ and currently have no translation framework. |
| [#1952](https://github.com/cjpais/Handy/pull/1952), [#1158](https://github.com/cjpais/Handy/pull/1158), [#1355](https://github.com/cjpais/Handy/pull/1355) | Skip tray engine | Savvy has one static template icon, no competing dynamic icon writers, and fallible tray setup. No equivalent per-transition icon panic to patch. |
| [#1548](https://github.com/cjpais/Handy/pull/1548), [#1823](https://github.com/cjpais/Handy/pull/1823) | Skip HTTP LLM transport | Savvy uses CLI-based recommendations and WebSocket transcription; it does not use Handy's OpenAI-compatible HTTP client. |
| [#1883](https://github.com/cjpais/Handy/pull/1883), [#1393](https://github.com/cjpais/Handy/pull/1393) | Skip repository-specific documentation | Handy README/agent-workflow edits do not describe Savvy. Preserve this repository's contributing and verification rules. |
| [#1889](https://github.com/cjpais/Handy/pull/1889) | Adapt documentation | Document development versus release signing identities and permission recovery. Savvy does not need Handy's Accessibility grant. |
| [#1720](https://github.com/cjpais/Handy/pull/1720) | Already covered by product UI | Savvy has dedicated General, Models, App, and Debug views. Handy sidebar layout is not a behavioral fix for them. |
| [#1813](https://github.com/cjpais/Handy/pull/1813), [#1491](https://github.com/cjpais/Handy/pull/1491) | Skip FFT constants | Savvy measures RMS, not FFT bins. Its existing scaling should be evaluated on physical microphones rather than copying unrelated decibel constants. |
| [#1779](https://github.com/cjpais/Handy/pull/1779) | Defer low-priority UI | Savvy has one feedback-volume slider with its current percentage shown. A reset control can be added with a broader settings-reset request. |
| [#1825](https://github.com/cjpais/Handy/pull/1825) | Defer installed-app migration | SMAppService improves Login Items attribution. Current launch-at-login works through Tauri; migration needs signed-bundle tests and careful removal of the old LaunchAgent. |
| [#1822](https://github.com/cjpais/Handy/pull/1822) | Not applicable | Savvy has no What's New view or markdown-renderer dependency in settings. |
| [#1865](https://github.com/cjpais/Handy/pull/1865) | Already covered | The pnpm lockfile already resolves js-yaml 4.3.1; no upgrade necessary for the upstream quadratic omap fix. |
| [#1675](https://github.com/cjpais/Handy/pull/1675) | Partly present | Cargo.lock already pins Tauri 2.11.5. Savvy's close-to-hide and reopen window behavior is implemented separately in tray.rs. |
| [#1665](https://github.com/cjpais/Handy/pull/1665) | Not applicable | Savvy exposes recording/transcript files rather than multiple embedded audio players. |
| [#1582](https://github.com/cjpais/Handy/pull/1582) | Defer caching | Avoid introducing device/configuration caches into Savvy's per-meeting capture. Worker dispatch addresses UI blocking without stale cached hardware state. |
| [#1597](https://github.com/cjpais/Handy/pull/1597) | Already covered | Savvy uses streaming transcript and explicit checking/thinking recommendation phases; it has no local non-streaming recognition phase. |
| [#1510](https://github.com/cjpais/Handy/pull/1510) | Not applicable | No Apple Intelligence/Swift AI bridge exists in Savvy's build. Command Line Tools are already documented. |
| [#1344](https://github.com/cjpais/Handy/pull/1344) | Not applicable to resampler | Savvy's transcription resample_linear function is stateless and creates no retained resampler history to clear. |
| [#1354](https://github.com/cjpais/Handy/pull/1354) | Not applicable to upstream destructor | Savvy has no Handy recorder/audio-manager Drop implementation or unwrap-on-poison in that destructor path. |
| [#1614](https://github.com/cjpais/Handy/pull/1614) | Already present | Recommendation coordination cancels pending generations and terminates CLI work on pause/stop; output deadlines already exist. |
| [#1471](https://github.com/cjpais/Handy/pull/1471) | Already documented | README states Apple Silicon releases and buildable but unsupported Intel. |
| [#1402](https://github.com/cjpais/Handy/pull/1402) | Not applicable to upstream selector | Handy's model post-processing dropdown does not exist in Savvy. Savvy has its own bounded dropdown menus. |
| [#1535](https://github.com/cjpais/Handy/pull/1535) | Defer diagnostics UI | Savvy already offers log-directory access. Add a live viewer if file logs prove insufficient for support. |

### Verification results

- `pnpm verify` passed on macOS with the pinned Node, pnpm, and Rust toolchain: formatting, TypeScript, ESLint, 44 frontend tests, 76 Rust tests, production Vite build, and Clippy with warnings denied. Two existing external-provider tests remain ignored.
- `cargo fmt --all --check`, `git diff --check`, and `cargo deny check` passed.
- Both published v0.1.0/v0.1.1 updater app bundles passed strict code-signature verification and have matching designated requirements.
- No dependencies, signing identities, installed applications, user settings, or macOS grants were changed. The app version and its Cargo.lock entry are bumped to 0.1.2 for the PR only.
- Physical microphone disconnect/reconnect, native theme rendering, and a full signed in-app update cycle remain manual release checks. The implementation is complete; those hardware results are not claimed.
- This PR includes this review and the permission investigation as specific exceptions to the ignored working-document directories. No release or tag is created.
