#!/bin/sh
# Copia diaria de la base de datos. Formato custom de pg_dump (se restaura con pg_restore).
set -eu
mkdir -p /backups
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
  sleep 86400
done
