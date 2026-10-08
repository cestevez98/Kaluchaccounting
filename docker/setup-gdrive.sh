#!/usr/bin/env bash
# Configura la copia de seguridad cifrada en Google Drive. Ejecutar UNA vez en el VPS, como root:
#
#   cd /opt/kaluch && bash docker/setup-gdrive.sh
#
# Necesitas un ordenador con navegador para autorizar el acceso a Google Drive (paso 1).
# Las copias se cifran en el servidor antes de subirse: Google no puede leerlas. Para restaurarlas
# en otro servidor hacen falta las DOS contraseñas que este script muestra al final.
#
# Para reutilizar contraseñas existentes (p. ej. al reinstalar el servidor):
#   CRYPT_PASSWORD=... CRYPT_SALT=... bash docker/setup-gdrive.sh
set -euo pipefail
cd "$(dirname "$0")/.."
C="docker compose -f docker/compose.prod.yml --env-file docker/.env.prod"
RC="$C run --rm --no-deps -T --entrypoint rclone backup"
FOLDER="${GDRIVE_FOLDER:-Kaluch ERP - copias de seguridad}"

mkdir -p docker/rclone && chmod 700 docker/rclone
$C build -q backup

cat <<'TXT'

==> 1/3 Autorizar el acceso a Google Drive
En TU ORDENADOR (no en el servidor):
  a) Descarga rclone: https://rclone.org/downloads/ (Windows: descomprime el .zip; Mac: brew install rclone)
  b) Abre una terminal (Windows: PowerShell en la carpeta descomprimida) y ejecuta:

       rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLmZpbGUifQ"

     (en Windows:  .\rclone.exe authorize "drive" "eyJzY29wZSI6ImRyaXZlLmZpbGUifQ")
  c) Se abre el navegador: entra con la cuenta de Google donde quieres las copias y acepta.
     El permiso es "drive.file": rclone solo ve los archivos que él mismo crea.
  d) La terminal muestra un texto entre ---> y <---End paste. Cópialo (empieza por {"access_token").

TXT
read -r -s -p "Pega aquí ese texto y pulsa Intro (no se mostrará): " TOKEN; echo
[[ "$TOKEN" == \{*access_token* ]] || { echo "No parece un token válido. Vuelve a ejecutar el script." >&2; exit 1; }

echo "==> 2/3 Creando la configuración cifrada"
NEW=0
if [ -z "${CRYPT_PASSWORD:-}" ]; then CRYPT_PASSWORD="$(openssl rand -base64 30 | tr -d '/+=')"; NEW=1; fi
if [ -z "${CRYPT_SALT:-}" ]; then CRYPT_SALT="$(openssl rand -base64 30 | tr -d '/+=')"; NEW=1; fi
umask 077
rm -f docker/rclone/rclone.conf
$RC config create gdrive drive scope=drive.file token="$TOKEN" --non-interactive >/dev/null
$RC config create kaluch-cifrado crypt remote="gdrive:$FOLDER" \
  password="$CRYPT_PASSWORD" password2="$CRYPT_SALT" --obscure --non-interactive >/dev/null
chmod 600 docker/rclone/rclone.conf

echo "==> 3/3 Prueba de subida"
$RC mkdir kaluch-cifrado:
echo "prueba $(date -u +%FT%TZ)" | $RC rcat kaluch-cifrado:prueba-conexion.txt
$RC cat kaluch-cifrado:prueba-conexion.txt >/dev/null
$RC deletefile kaluch-cifrado:prueba-conexion.txt
$C up -d backup
echo "    Conexión correcta. La próxima copia diaria ya se subirá a Google Drive (carpeta \"$FOLDER\")."

if [ "$NEW" = 1 ]; then
  cat <<TXT

==================================================================
 GUARDA ESTAS DOS CONTRASEÑAS EN TU GESTOR DE CONTRASEÑAS.
 Sin ellas, las copias de Google Drive NO se pueden descifrar si se
 pierde el servidor. No se vuelven a mostrar.

   Contraseña de cifrado (CRYPT_PASSWORD): $CRYPT_PASSWORD
   Sal de cifrado        (CRYPT_SALT):     $CRYPT_SALT
==================================================================
TXT
fi
