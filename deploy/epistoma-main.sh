#!/usr/bin/env bash
# Run on Epistoma after Verify passes for the exact main commit.
set -euo pipefail

sha="${1:?expected main commit SHA}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 2; }
exec 9>/tmp/savvy-deploy.lock
flock -n 9

source_dir=/home/jaume/savvy-deploy-source
release="/opt/savvy/releases/$sha"
previous="$(readlink -f /opt/savvy/current)"
if [[ "$previous" == "$release" ]]; then
  sudo systemctl is-active --quiet savvy-backend.service
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
trap 'rm -rf "$pnpm_bin"' EXIT
corepack enable --install-directory "$pnpm_bin"
export PATH="$pnpm_bin:$PATH"
pnpm --dir backend install --frozen-lockfile
pnpm --dir backend build

package="$(mktemp -d /home/jaume/savvy-package.XXXXXX)"
trap 'rm -rf "$package" "$pnpm_bin"' EXIT
mkdir -p "$package/backend" "$package/config"
cp -a backend/build backend/dist backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml "$package/backend/"
cp config/managed-catalog.json "$package/config/"
pnpm --dir "$package/backend" install --prod --frozen-lockfile
sudo install -d -o savvy -g savvy -m 0750 "$release"
sudo cp -a "$package/." "$release/"
sudo chown -R savvy:savvy "$release"

sudo install -m 0644 deploy/savvy-release.mjs /usr/local/libexec/savvy-release.mjs
funding_preflight() {
  sudo -u savvy /opt/node-v22.23.4-linux-x64/bin/node \
    /usr/local/libexec/savvy-release.mjs check /opt/savvy/current "$1" /var/lib/savvy/service.sqlite
}
switch_release() {
  sudo /opt/node-v22.23.4-linux-x64/bin/node \
    /usr/local/libexec/savvy-release.mjs switch /opt/savvy/current "$1" /var/lib/savvy/service.sqlite
}
funding_preflight "$release"

sudo install -m 0644 deploy/savvy-backend.service /etc/systemd/system/
sudo systemctl daemon-reload

migration_started=false
restore_on_error() {
  status=$?
  if [[ $status -ne 0 && "$migration_started" == false ]]; then
    if switch_release "$previous"; then
      sudo systemctl start savvy-backend.service
    else
      echo 'Funding guard refused automatic rollback; backend stays stopped.' >&2
    fi
  fi
  rm -rf "$package" "$pnpm_bin"
}
trap restore_on_error EXIT
sudo systemctl is-active --quiet savvy-backend.service
sudo systemctl stop savvy-backend.service

# There is no nightly backup (it stopped the backend daily), so every deploy
# snapshots both databases while the backend is down anyway.
snapshot="/var/backups/savvy/$(date -u +%Y%m%dT%H%M%SZ)-pre-${sha:0:12}"
sudo -u savvy env \
  SAVVY_AUTH_DATABASE=/var/lib/savvy/auth.sqlite \
  SAVVY_DB_PATH=/var/lib/savvy/service.sqlite \
  SAVVY_HOST=127.0.0.1 PORT=8788 \
  sh -c 'cd "$1/backend" && exec /opt/node-v22.23.4-linux-x64/bin/node --env-file=/etc/savvy/backend.env build/backup.js "$2"' sh "$previous" "$snapshot"

run_migration() {
  sudo -u savvy env \
    SAVVY_AUTH_DATABASE=/var/lib/savvy/auth.sqlite \
    SAVVY_DB_PATH=/var/lib/savvy/service.sqlite \
    sh -c 'cd "$1/backend" && exec /opt/node-v22.23.4-linux-x64/bin/node --env-file=/etc/savvy/backend.env build/migrate.js "$2"' sh "$release" "$1"
}
switch_release "$release"
# The service migration is one transaction that refuses rather than half-applies,
# so a refusal still rolls back to the previous release.
run_migration service
migration_started=true
run_migration auth
sudo systemctl start savvy-backend.service
curl --fail --retry 24 --retry-delay 5 --retry-all-errors \
  -H 'CF-Connecting-IP: 127.0.0.1' http://127.0.0.1:8788/ready > /dev/null
test "$(readlink -f /opt/savvy/current)" = "$release"

# Disk on this shared host is scarce: keep the 14 newest snapshots this script or the
# former nightly job wrote and, besides the running, previous and staging releases,
# the 3 newest production releases. NUL-separated so odd names cannot split.
prune_oldest() {
  local keep="$1" root="$2" pattern="$3"
  shift 3
  sudo find "$root" -mindepth 1 -maxdepth 1 -type d -regextype egrep \
    -regex "$root/$pattern" -printf '%T@\t%p\0' |
    sort -z -rn | cut -z -f2- |
    { grep -zvxF "${@/#/-e}" || true; } |
    tail -z -n "+$((keep + 1))" | xargs -0 -r sudo rm -rf --
}
staging="$(readlink -f /opt/savvy/staging || true)"
prune_oldest 13 /var/backups/savvy '[0-9]{8}T[0-9]{6}Z(-pre-[0-9a-f]{12})?' "$snapshot"
prune_oldest 3 /opt/savvy/releases '[0-9a-f]{40}' "$release" "$previous" "${staging:-$release}"
echo "Deployed Savvy backend $sha; previous release: $previous; snapshot: $snapshot"
