#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo "macOS required" >&2; exit 1; }
: "${SAVVY_SERVICE_URL:?Set the local service URL}"
: "${SAVVY_OIDC_ISSUER:?Set the local auth issuer}"
: "${SAVVY_OIDC_CLIENT_ID:?Set the native client ID}"
: "${SAVVY_OIDC_AUDIENCE:?Set the service audience}"
[[ "${SAVVY_SERVICE_URL%/}" == "${SAVVY_OIDC_ISSUER%/}" ]] || { echo "The unified integration build requires the same service and issuer origin" >&2; exit 1; }
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
pnpm tauri build --features local-integration --config src-tauri/tauri.integration.conf.json --bundles app
bundle="$repo_root/target/release/bundle/macos/Savvy Integration.app"
codesign --force --deep --sign - --entitlements "$repo_root/src-tauri/Entitlements.plist" "$bundle"
codesign --verify --deep --strict "$bundle"
