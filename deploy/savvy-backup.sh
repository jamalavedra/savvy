#!/bin/sh
set -eu
umask 077

: "${RUNTIME_DIRECTORY:?Run through savvy-backup.service}"
[ "$#" -eq 1 ] || exit 2
restart_flag="$RUNTIME_DIRECTORY/restart-required"

case "$1" in
  restart)
    if [ -f "$restart_flag" ]; then
      systemctl start savvy-backend.service
      rm "$restart_flag"
    fi
    ;;
  backup)
    # An inactive backend must stay inactive; a failed prior restart needs recovery.
    [ ! -e "$restart_flag" ]
    systemctl is-active --quiet savvy-backend.service
    : > "$restart_flag"
    systemctl stop savvy-backend.service
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    runuser -u savvy -- /opt/node-v22.23.4-linux-x64/bin/node \
      --env-file=/etc/savvy/backend.env \
      /opt/savvy/current/backend/build/backup.js "/var/backups/savvy/$stamp"
    ;;
  *) exit 2 ;;
esac
