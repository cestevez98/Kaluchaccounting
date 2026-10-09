#!/usr/bin/env bash
# Actualización automática de Kaluch ERP: si hay commits nuevos en la rama desplegada, los descarga,
# reconstruye y reinicia. La ejecuta un temporizador de systemd cada 10 minutos (ver bootstrap-vps.sh).
# Registro: journalctl -u kaluch-update
set -euo pipefail
DIR=/opt/kaluch
cd "$DIR"
BRANCH="$(cat /etc/kaluch-branch 2>/dev/null || git rev-parse --abbrev-ref HEAD)"
export GIT_SSH_COMMAND="ssh -i /root/.ssh/kaluch_deploy -o IdentitiesOnly=yes"
C="docker compose -f docker/compose.prod.yml --env-file docker/.env.prod"

# Última versión construida y arrancada con éxito: si una construcción falla, se reintenta en la próxima pasada.
DEPLOYED_FILE="$DIR/.deployed-commit"

git fetch -q origin "$BRANCH"
REMOTE="$(git rev-parse "origin/$BRANCH")"
DEPLOYED="$(cat "$DEPLOYED_FILE" 2>/dev/null || true)"
[ "$DEPLOYED" = "$REMOTE" ] && exit 0

# No interrumpir una importación del Excel en curso.
if $C top api 2>/dev/null | grep -q "etl/dist/cli.js"; then
  echo "Hay una importación en curso; se actualizará en la próxima pasada"
  exit 0
fi

echo "Actualizando ${DEPLOYED:0:7} → ${REMOTE:0:7}"
git reset -q --hard "origin/$BRANCH"
if ! $C up -d --build --remove-orphans; then
  echo "ERROR: la construcción o el arranque han fallado; se reintentará en la próxima pasada" >&2
  exit 1
fi
echo "$REMOTE" > "$DEPLOYED_FILE"
docker image prune -f >/dev/null
echo "Actualizado a ${REMOTE:0:7}"
