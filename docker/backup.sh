#!/bin/sh
# Copia diaria de la base de datos. Formato custom de pg_dump (se restaura con pg_restore).
# Si existe la configuración de rclone (docker/setup-gdrive.sh), cada copia se sube además
# cifrada a Google Drive.
set -eu
mkdir -p /backups
REMOTE="kaluch-cifrado:"
offsite_enabled() { [ -f "${RCLONE_CONFIG:-/config/rclone/rclone.conf}" ] && rclone listremotes 2>/dev/null | grep -qx "$REMOTE"; }

while true; do
  file="/backups/kaluch-$(date -u +%Y%m%d-%H%M%S).dump"
  if pg_dump --format=custom --compress=9 --file="$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "$(date -u +%FT%TZ) copia creada: $file ($(du -h "$file" | cut -f1))"
  else
    echo "$(date -u +%FT%TZ) ERROR al crear la copia" >&2
    rm -f "$file.tmp"
  fi
  find /backups -name 'kaluch-*.dump' -mtime +"${KEEP_DAYS:-30}" -delete

  if offsite_enabled; then
    # copy (no sync): borrar una copia local nunca borra la de Drive.
    if rclone copy /backups "$REMOTE" --include 'kaluch-*.dump' --stats-log-level NOTICE; then
      rclone delete "$REMOTE" --min-age "${OFFSITE_KEEP_DAYS:-180}d" --include 'kaluch-*.dump' || true
      echo "$(date -u +%FT%TZ) copia subida a Google Drive (cifrada)"
    else
      echo "$(date -u +%FT%TZ) ERROR al subir la copia a Google Drive" >&2
    fi
  fi
  sleep 86400
done
