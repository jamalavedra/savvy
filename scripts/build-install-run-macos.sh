#!/usr/bin/env bash

set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "This script only supports macOS." >&2; exit 1; }

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
built_app="$repo_root/target/release/bundle/macos/Savvy.app"
installed_app="/Applications/Savvy.app"
database="$HOME/Library/Application Support/com.alamaslabs.savvy/savvy-v2.sqlite"

ensure_no_active_meeting() {
  # `return 0`, not a bare `return`: a bare one propagates the failed test's exit
  # status and `set -e` then kills the script silently before it builds anything.
  [[ -f "$database" ]] || return 0
  latest_state="$(sqlite3 "$database" 'select state from meeting_sessions order by started_at desc limit 1;')"
  if [[ "$latest_state" == "Recording" || "$latest_state" == "Paused" ]]; then
    echo "Refusing to replace Savvy during an active meeting ($latest_state)." >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--verify" ]]; then
  (cd "$repo_root" && pnpm verify)
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--verify]" >&2
  exit 1
fi

ensure_no_active_meeting
# Local installs never auto-update, and building updater artifacts would require the
# updater signing key on every dev machine. Only the release workflow produces them.
(cd "$repo_root" && pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}')
signing_identity="${SAVVY_SIGNING_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/"Apple Development:/ { print $2; exit }')}"
[[ -n "$signing_identity" ]] || { echo "No Apple Development signing identity found." >&2; exit 1; }
codesign --force --deep --options runtime --timestamp \
  --entitlements "$repo_root/src-tauri/Entitlements.plist" \
  --sign "$signing_identity" "$built_app"
codesign --verify --deep --strict --verbose=2 "$built_app"
ensure_no_active_meeting

pkill -x savvy 2>/dev/null || true
for _ in {1..20}; do
  pgrep -x savvy >/dev/null || break
  sleep 0.25
done
pgrep -x savvy >/dev/null && { echo "Savvy did not stop." >&2; exit 1; }

backup=""
if [[ -d "$installed_app" ]]; then
  backup="$installed_app.backup-$(date +%Y%m%d-%H%M%S)"
  mv "$installed_app" "$backup"
fi
if ! ditto "$built_app" "$installed_app"; then
  [[ -n "$backup" ]] && mv "$backup" "$installed_app"
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$installed_app"
built_hash="$(shasum -a 256 "$built_app/Contents/MacOS/savvy" | awk '{print $1}')"
installed_hash="$(shasum -a 256 "$installed_app/Contents/MacOS/savvy" | awk '{print $1}')"
[[ "$built_hash" == "$installed_hash" ]] || { echo "Installed binary does not match the build." >&2; exit 1; }

open -n "$installed_app"
for _ in {1..20}; do
  pgrep -f "$installed_app/Contents/MacOS/savvy" >/dev/null && break
  sleep 0.25
done
pgrep -f "$installed_app/Contents/MacOS/savvy" >/dev/null || { echo "Installed Savvy did not stay running." >&2; exit 1; }

echo "Savvy installed and running: $installed_hash"
[[ -n "$backup" ]] && echo "Previous bundle: $backup"
