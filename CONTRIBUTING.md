# Contributing

## Getting set up

Build prerequisites are in the [README](README.md#building-from-source). Run `pnpm verify` before
opening a pull request — it runs formatting, typecheck, lint, the frontend and Rust test suites,
a production build, and Clippy with warnings denied. CI runs the same command.

CI runs the full test suite on macOS and Windows, produces a Windows preview installer, and
runs `cargo check` on Linux. Native audio and window behavior require testing on the target
OS. Complete the Windows release acceptance checklist in the README before publishing.

## Implementation rules

These are invariants rather than style preferences. A change that breaks one of them needs a
good reason in the pull request description.

- Never commit real client data, meeting recordings, transcripts, provider credentials, or Apple
  signing credentials. Test fixtures are synthetic, and must stay that way.
- Keep native integrations behind platform `cfg` guards. Share meeting logic across macOS
  and Windows; Linux remains compile-only.
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
