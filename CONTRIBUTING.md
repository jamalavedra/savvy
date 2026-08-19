# Contributing

## Getting set up

Build prerequisites are in the [README](README.md#building-from-source). Run `pnpm verify` before
opening a pull request — it runs formatting, typecheck, lint, the frontend and Rust test suites,
a production build, and Clippy with warnings denied. CI runs the same command.

The test suite runs on macOS only — `savvy-audio` depends on ScreenCaptureKit, so the workspace
does not compile anywhere else. CI additionally `cargo check`s Linux and Windows so the
non-macOS stubs do not rot. Audio capture, Keychain access, the overlay window, and the tray are
macOS-only, so changes touching those need a Mac to verify.

## Implementation rules

These are invariants rather than style preferences. A change that breaks one of them needs a
good reason in the pull request description.

- Never commit real client data, meeting recordings, transcripts, provider credentials, or Apple
  signing credentials. Test fixtures are synthetic, and must stay that way.
- Keep platform-specific macOS code behind interfaces and `cfg(target_os = "macos")` guards, so
  the portable crates keep compiling and testing everywhere.
- Preserve source locators through ingestion, retrieval, prompting, and recommendation
  validation. A recommendation that cannot be traced back to a source is a bug.
- Provider failures must never stop local recording. Transcription reconnects on its own; a
  meeting in progress outranks any network call.

## Pull requests

Describe what the code does now, not the approaches you discarded along the way. Plain language —
a bug fix is a bug fix. One logical change per commit, imperative mood, subject line under 72
characters.

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).
