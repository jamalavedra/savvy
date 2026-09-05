# Update and permission investigation

Investigated September 5, 2026 against Savvy `02bad43`, its published v0.1.0 and v0.1.1 updater bundles, Tauri 2.11.5, updater 2.10.1, and macOS permissions plugin 2.3.0.

## Findings

The repeated setup screen has a confirmed application-level cause. `App.tsx` read `onboardingCompleted`, then checked microphone permission even when setup was complete. One `false` result changed the UI to the returning-user setup screen. That path did not distinguish a revoked grant from a temporarily unrecognized grant after replacement of the app bundle. It also prevented access to the rest of the app while the user tried to recover.

This was a permission-repair screen, not proof that stored onboarding had been erased. Inspection of the current installed settings found `onboardingCompleted: true`. Only that flag and field types were inspected for this investigation; settings values, credentials, source documents, and meeting content are not included here. The flag's current value cannot establish its value during the reported incident.

A separate confirmed settings-loader defect could also repeat setup. When any one JSON field had the wrong type, `settings::load` returned all defaults, including `onboardingCompleted: false`. Correctly typed newly added or missing fields were already handled through Serde defaults. Malformed fields were the gap. This defect is fixed, but there is no incident evidence that it caused this particular update failure.

## Signing identity was checked against shipped artifacts

Both published updater archives were downloaded into a temporary inspection directory and extracted without launching either application. Both passed `codesign --verify --deep --strict`.

| Property               | v0.1.0                   | v0.1.1                   |
| ---------------------- | ------------------------ | ------------------------ |
| Bundle identifier      | `com.alamaslabs.savvy`   | `com.alamaslabs.savvy`   |
| Signing channel        | Developer ID Application | Developer ID Application |
| Team identifier        | Same team                | Same team                |
| Designated requirement | Same requirement         | Same requirement         |
| Published              | August 20, 2026          | August 31, 2026          |

Apple explains that macOS uses designated requirements to recognize an updated app when checking microphone authorization. The matching requirements rule out a changed release identity as the explanation for a v0.1.0 to v0.1.1 release-to-release update. They do not prove the state of the user's TCC database. [Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)

The local build/install script signs with an Apple Development identity by default. Moving between a local build and a published release can therefore require new grants even when the bundle identifier stays the same. Apple's documentation explicitly distinguishes these signing channels. Do not reset permissions or change signing requirements to hide this distinction.

## Why relaunch can change the answer

The pinned Tauri implementation was inspected directly in the Cargo registry. `AppHandle::restart` eventually calls `tauri::process::restart`. Its macOS path reads `CFBundleExecutable` from the replacement Info.plist and directly spawns `Contents/MacOS/<executable>` before exiting the old process. It does not launch the replacement through Launch Services or wait for the old instance to exit first. [Tauri 2.11.5 process implementation](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/process.rs)

The updater replaces the app bundle, but leaves application support settings in place. Combining a direct child-process relaunch with a one-shot startup permission gate is a plausible explanation for the observed "allowed in System Settings, recognized only after quitting and reopening" sequence. This remains an inference: no TCC trace from the incident was available, and the historical update was not reproduced against the user's installed application.

The changed relaunch path waits for the previous process to exit, then runs `/usr/bin/open -n <bundle>` through Launch Services. The app path is passed as an argument, never interpolated into shell code. This also avoids a replacement instance seeing the old instance's still-active meeting record. Apple's explanation of launch contexts distinguishes Launch Services application launches from ordinary process spawning. [Apple WWDC23 launch constraints](https://developer.apple.com/videos/play/wwdc2023/10266/)

## The reported permission name

Savvy checks microphone and screen/system-audio access. Its frontend has no Accessibility check or request, and its Tauri capability file does not authorize those Accessibility plugin commands. Handy does require Accessibility for its dictation shortcuts and input automation. Handy has an open report about stale Accessibility entries after upgrades, but that is not evidence that Savvy exercises the same API. [Handy issue #1618](https://github.com/cjpais/Handy/issues/1618)

Savvy's permission plugin checks microphone status through `AVCaptureDevice.authorizationStatusForMediaType` and screen capture through `CGPreflightScreenCaptureAccess`. Its actual system-audio capture uses ScreenCaptureKit. The fix adds an explicit ScreenCaptureKit permission probe when the user presses Check again or requests screen access and preflight still reports false. Successful retrieval of shareable content marks the permission allowed; it does not claim that a recording has been tested. Passive startup and timer checks do not run that potentially prompting probe. [ScreenCaptureKit shareable content](https://developer.apple.com/documentation/screencapturekit/scshareablecontent)

## Implemented behavior

- Completed onboarding remains completed. The microphone check at Start listening still enforces access before recording.
- Invalid stored field types no longer discard valid preferences or a valid completion flag. Existing migrations still run, and loading does not rewrite the original file.
- An explicit screen-access recheck uses ScreenCaptureKit when CoreGraphics preflight says no.
- Setup offers Reopen Savvy while a requested permission is still unrecognized.
- macOS updates and that recovery action use the same Launch Services relaunch helper after the old process exits.
- Update/reopen requests refuse to interrupt a meeting. Capture and settings transitions are serialized, and new operations are blocked while an accepted update is running.
- Download/install or relaunch-scheduling failures are shown to the user and unblock operations.
- Startup update checks begin after application state and windows have been initialized.
- Quit waits for capture and settings work on a worker thread so the macOS event loop can finish pending native operations.

No grant is fabricated, no TCC database is edited, and no permission is reset automatically.

## Verification and remaining limits

`pnpm verify` passed with 44 frontend tests and 76 Rust tests; two pre-existing external-provider tests remain ignored. Formatting, TypeScript, ESLint, the production build, and Clippy also passed.

Regression tests exercise completed setup with a false microphone reading, valid preferences alongside malformed fields, stale screen preflight with a successful ScreenCaptureKit probe, reopen error reporting, and the relaunch helper waiting for its parent to exit while preserving literal arguments. Existing tests still cover genuinely missing microphone access in first-run setup.

The relaunch helper test runs a harmless substitute command; it does not launch an app, grant permission, or access the microphone. Native compilation and tests cannot prove a particular macOS TCC transition.

For release verification, use a signed installed build with pre-existing microphone and screen grants, update it, and confirm that the workspace opens, both audio sources can record, and the completion flag stays true. Also check a denied microphone, screen access granted while the app runs, failure to download an update, and an update attempt during a meeting.

The first upgrade into this fix is restarted by the old installed version. That version still uses Tauri's old restart path. The new onboarding behavior applies immediately, but a stale process permission state may require one Reopen Savvy action or a normal quit/reopen. Later updates use the new launch path. A complete signed update-cycle test remains manual; this work does not claim that the historical TCC failure was reproduced.
