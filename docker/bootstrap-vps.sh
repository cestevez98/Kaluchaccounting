#!/usr/bin/env bash
# Instalación inicial de Kaluch ERP en un VPS Ubuntu 24.04 (Hostinger).
# Ejecutar como root desde la "Consola web" del panel de Hostinger o por SSH:
#
#   curl -fsSL https://raw.githubusercontent.com/... | bash      (si el repo fuera público)
#   bash bootstrap-vps.sh                                         (copiado al servidor)
#
# Variables opcionales: BRANCH (rama a desplegar), DOMAIN, ADMIN_EMAIL.
set -euo pipefail

REPO="git@github.com:cestevez98/Kaluchaccounting.git"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-kgtaccounting.com}"
ADMIN_EMAIL="${ADMIN_EMAIL:-kaluchexport@gmail.com}"
DIR=/opt/kaluch
KEY=/root/.ssh/kaluch_deploy

echo "==> 1/6 Paquetes del sistema (Docker, git, cortafuegos)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 git ufw openssl ca-certificates >/dev/null
systemctl enable --now docker

echo "==> 2/6 Cortafuegos: solo SSH, HTTP y HTTPS"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

echo "==> 3/6 Clave de despliegue (solo lectura del repositorio)"
if [ ! -f "$KEY" ]; then
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  ssh-keygen -t ed25519 -N "" -C "kaluch-vps-deploy" -f "$KEY" >/dev/null
  ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
  echo
  echo "------------------------------------------------------------------"
  echo "Añade esta clave en GitHub → repositorio Kaluchaccounting → Settings"
  echo "→ Deploy keys → Add deploy key (SIN marcar 'Allow write access'):"
  echo
  cat "$KEY.pub"
  echo
  echo "Después vuelve a ejecutar este mismo script."
  echo "------------------------------------------------------------------"
  exit 0
fi
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes"

echo "==> 4/6 Código (rama $BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

echo "==> 5/6 Configuración (docker/.env.prod)"
if [ ! -f docker/.env.prod ]; then
  umask 077
  sed -e "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" \
      -e "s|^ACME_EMAIL=.*|ACME_EMAIL=$ADMIN_EMAIL|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 32)|" \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" \
      docker/env.prod.example > docker/.env.prod
  echo "    Creado con secretos aleatorios (no salen del servidor)."
fi

echo "==> 6/6 Construcción y arranque (tarda unos minutos la primera vez)"
docker compose -f docker/compose.prod.yml --env-file docker/.env.prod up -d --build

echo "    Esperando a la API…"
for i in $(seq 1 60); do
  if docker compose -f docker/compose.prod.yml --env-file docker/.env.prod exec -T api node -e "fetch('http://localhost:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 5
done

if [ ! -f /root/.kaluch-admin-created ]; then
  PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  docker compose -f docker/compose.prod.yml --env-file docker/.env.prod exec -T \
    -e ADMIN_EMAIL="$ADMIN_EMAIL" -e ADMIN_PASSWORD="$PASS" api node packages/db/dist/seed/base.js
  touch /root/.kaluch-admin-created
  ( umask 077; printf 'Usuario: %s\nContraseña inicial: %s\nCámbiala al entrar y borra este fichero: rm %s\n' "$ADMIN_EMAIL" "$PASS" /root/kaluch-admin-inicial.txt > /root/kaluch-admin-inicial.txt )
  echo
  echo "=================================================================="
  echo " Kaluch ERP listo en https://$DOMAIN"
  echo " Usuario inicial: $ADMIN_EMAIL"
  echo " Contraseña inicial: en /root/kaluch-admin-inicial.txt (solo root). Cámbiala al entrar."
  echo " Al entrar se te pedirá activar la verificación en dos pasos."
  echo "=================================================================="
else
  echo "Actualización completada: https://$DOMAIN"
fi
