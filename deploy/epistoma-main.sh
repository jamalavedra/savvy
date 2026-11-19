#!/usr/bin/env bash
# Run on Epistoma after Verify passes for the exact main commit. Runs as an unprivileged build
# account; the host's savvy-install-release does every root step (deploy/README.md).
set -euo pipefail

sha="${1:?expected main commit SHA}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 2; }
exec 9>"$HOME/.savvy-deploy.lock"
flock -n 9

source_dir="$HOME/savvy-deploy-source"
if [[ "$(readlink -f /opt/savvy/current)" == "/opt/savvy/releases/$sha" ]]; then
  systemctl is-active --quiet savvy-backend.service
  curl --fail --silent -H 'CF-Connecting-IP: 127.0.0.1' http://127.0.0.1:8788/ready > /dev/null
  echo 'Savvy backend already runs this commit.'
  exit 0
fi
if [[ ! -d "$source_dir/.git" ]]; then
  git clone --quiet https://github.com/jamalavedra/savvy.git "$source_dir"
fi
cd "$source_dir"
test -z "$(git status --porcelain --untracked-files=no)"
git fetch origin main
if [[ "$(git rev-parse origin/main)" != "$sha" ]]; then
  echo 'A newer main commit superseded this deploy.'
  exit 0
fi
git checkout --detach "$sha"
export PATH="/opt/node-v22.23.4-linux-x64/bin:$PATH"
pnpm_bin="$(mktemp -d /tmp/savvy-pnpm.XXXXXX)"
package="$(mktemp -d "$HOME/savvy-package.XXXXXX")"
trap 'rm -rf "$package" "$pnpm_bin"' EXIT
corepack enable --install-directory "$pnpm_bin"
export PATH="$pnpm_bin:$PATH"
pnpm --dir backend install --frozen-lockfile
pnpm --dir backend build

mkdir -p "$package/backend" "$package/config" "$package/deploy"
cp -a backend/build backend/dist backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml "$package/backend/"
cp config/managed-catalog.json "$package/config/"
cp deploy/savvy-release.mjs "$package/deploy/"
pnpm --dir "$package/backend" install --prod --frozen-lockfile

sudo /usr/local/libexec/savvy-install-release "$sha" "$package"
