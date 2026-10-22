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
export PATH="/opt/node-v22.23.2-linux-x64/bin:$PATH"
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

sudo systemctl stop savvy-backup.timer
timer_stopped=true
migration_started=false
restore_on_error() {
  status=$?
  if [[ $status -ne 0 && "$migration_started" == false ]]; then
    sudo ln -sfn "$previous" /opt/savvy/current.previous
    sudo mv -Tf /opt/savvy/current.previous /opt/savvy/current
    sudo systemctl start savvy-backend.service
  fi
  if [[ "$timer_stopped" == true && ( $status -eq 0 || "$migration_started" == false ) ]]; then
    sudo systemctl start savvy-backup.timer
  fi
  rm -rf "$package" "$pnpm_bin"
}
trap restore_on_error EXIT
sudo systemctl stop savvy-backup.service
sudo systemctl start savvy-backup.service
sudo systemctl is-active --quiet savvy-backend.service
sudo systemctl stop savvy-backend.service
sudo ln -sfn "$release" /opt/savvy/current.next
sudo mv -Tf /opt/savvy/current.next /opt/savvy/current
migration_started=true
sudo -u savvy env \
  SAVVY_AUTH_DATABASE=/var/lib/savvy/auth.sqlite \
  SAVVY_DB_PATH=/var/lib/savvy/service.sqlite \
  sh -c 'cd "$1/backend" && exec /opt/node-v22.23.2-linux-x64/bin/node --env-file=/etc/savvy/backend.env build/migrate.js' sh "$release"
sudo systemctl start savvy-backend.service
curl --fail --retry 24 --retry-delay 5 --retry-all-errors \
  -H 'CF-Connecting-IP: 127.0.0.1' http://127.0.0.1:8788/ready > /dev/null
test "$(readlink -f /opt/savvy/current)" = "$release"
sudo systemctl start savvy-backup.timer
sudo systemctl is-active --quiet savvy-backup.timer
timer_stopped=false
echo "Deployed Savvy backend $sha; previous release: $previous"
