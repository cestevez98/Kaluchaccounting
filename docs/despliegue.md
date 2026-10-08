# Despliegue en producción (VPS Hostinger)

| | |
|---|---|
| Servidor | Hostinger KVM 2 (2 vCPU, 8 GB, 100 GB NVMe), **Düsseldorf (UE)**, Ubuntu 24.04 LTS |
| IP | 187.7.70.196 · 2a02:4780:7e:f59a::1 |
| Dominio | **kgtaccounting.com** → registros A y AAAA apuntando al VPS (configurados el 08/10/2026); `www` redirige al dominio |
| HTTPS | Automático con Caddy + Let's Encrypt |

## Arquitectura en el servidor

```
Internet ──443──► caddy ──► web (Next.js) ──/api/*──► api (NestJS) ──► postgres
                                                                  ▲
                                               backup (pg_dump diario)
```

Solo Caddy publica puertos (80/443). PostgreSQL y la API no son accesibles desde fuera.
El cortafuegos (ufw) solo admite SSH, HTTP y HTTPS.

## Primera instalación (≈ 10 minutos)

1. En el panel de Hostinger → VPS → **Consola web** (entras como `root`).
2. Copia el script al servidor y ejecútalo:
   ```bash
   curl -fsSL -o bootstrap-vps.sh "https://raw.githubusercontent.com/cestevez98/Kaluchaccounting/<rama>/docker/bootstrap-vps.sh"
   ```
   El repositorio es privado, así que esa URL no funcionará sin autenticación. Lo más sencillo es
   abrir `docker/bootstrap-vps.sh` en GitHub, pulsar "Raw", copiar el contenido y pegarlo en el
   servidor con `nano bootstrap-vps.sh`. Después:
   ```bash
   BRANCH=claude/kaluch-erp-migration-ojf4hm bash bootstrap-vps.sh
   ```
3. La primera ejecución instala Docker y el cortafuegos, crea una **clave de despliegue** y la muestra.
   Añádela en GitHub → *Settings → Deploy keys → Add deploy key* (solo lectura, sin "Allow write access").
4. Vuelve a ejecutar el mismo comando. Clona el código, genera secretos aleatorios en
   `docker/.env.prod` (no salen del servidor), construye las imágenes, arranca todo y crea el usuario
   Superadministrador inicial. **La contraseña inicial se muestra una sola vez**: cámbiala y guárdala.
5. Abre https://kgtaccounting.com. El primer acceso pide activar la verificación en dos pasos (2FA).

## Actualizar a una versión nueva

**Automático:** el servidor comprueba cada 10 minutos si hay commits nuevos en la rama desplegada y, si
los hay, reconstruye y reinicia (no lo hace mientras hay una importación del Excel en curso). Registro:
`journalctl -u kaluch-update`. Para desactivarlo: `systemctl disable --now kaluch-update.timer`.

**Manual:**

```bash
cd /opt/kaluch && BRANCH=main bash docker/bootstrap-vps.sh
```
Descarga la rama, reconstruye las imágenes y aplica las migraciones de base de datos al arrancar la
API. No borra datos.

## Cargar los datos reales del Excel

**Desde la aplicación (recomendado):** Configuración → **Importar Excel** (solo administradores).
Subes "Balance de comprobación.xlsx" y la aplicación ejecuta toda la migración en segundo plano, en unos 10–15
minutos: plan de cuentas, tasas, caja y bancos, deudas, proveedores y nómina, y conciliación. La pantalla
muestra el avance y el registro, y el archivo se borra del servidor al terminar. La migración completa
solo se puede hacer una vez, sobre una base vacía; después, la misma pantalla sirve para actualizar las tasas.

**Por consola** (alternativa):

```bash
mkdir -p /opt/kaluch-data && chmod 700 /opt/kaluch-data
# Sube el Excel desde tu ordenador:  scp "Balance de comprobación.xlsx" root@187.7.70.196:/opt/kaluch-data/balance.xlsx
# Los contenedores se ejecutan sin privilegios (uid 1001): la carpeta debe ser suya.
chown -R 1001 /opt/kaluch-data && chmod 600 /opt/kaluch-data/*.xlsx
cd /opt/kaluch
C="docker compose -f docker/compose.prod.yml --env-file docker/.env.prod run --rm -v /opt/kaluch-data:/data api node packages/etl/dist/cli.js"
$C all /data/balance.xlsx                     # plan de cuentas, tasas y valores de referencia del BC
$C treasury /data/balance.xlsx --revalue-until=   # caja y bancos: apertura 31/03/2026 y movimientos (~8 min)
$C debts /data/balance.xlsx                   # deudas, proveedores y nómina; revaluaciones y reclasificación abril–octubre
$C explain                                    # explicaciones automáticas (comprobadas al céntimo)
$C compare /data/conciliacion.xlsx            # informe de conciliación con el BC
```
Las migraciones de tesorería y de deudas se ejecutan **una sola vez**, en ese orden, sobre una base recién importada.

## Copias de seguridad

| Nivel | Qué | Retención |
|---|---|---|
| 1 | `pg_dump` diario en el servidor (volumen `backups`) | 30 días (`BACKUP_KEEP_DAYS`) |
| 2 | La misma copia, **cifrada**, en **Google Drive** | 180 días (`OFFSITE_KEEP_DAYS`) |
| 3 | Instantáneas semanales del VPS (panel de Hostinger → *Backups y monitoreo*) | Las de Hostinger |

### Activar la copia en Google Drive (una vez, ≈ 5 minutos)
```bash
cd /opt/kaluch && bash docker/setup-gdrive.sh
```
El script te guía:
1. En **tu ordenador** descargas rclone (https://rclone.org/downloads/) y ejecutas
   `rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLmZpbGUifQ"`. Se abre el navegador,
   entras con la cuenta de Google y aceptas. El permiso es `drive.file`: solo da acceso a los
   archivos que crea la propia copia, no al resto de tu Drive.
2. Pegas en la **consola del servidor** el texto que muestra la terminal. No se pega en ningún chat.
3. El script crea la carpeta **"Kaluch ERP - copias de seguridad"** en Drive, prueba la subida y
   muestra **dos contraseñas de cifrado una sola vez**. Guárdalas en tu gestor de contraseñas: sin
   ellas no se pueden descifrar las copias si se pierde el servidor.

Las copias se cifran en el servidor antes de salir (rclone crypt: contenido y nombres), así que
Google no puede leerlas. Se suben con `copy` y no con `sync`: borrar algo en el servidor nunca borra
la copia de Drive. El registro está en `docker compose ... logs backup`.

### Restaurar
Desde una copia del servidor:
```bash
cd /opt/kaluch
C="docker compose -f docker/compose.prod.yml --env-file docker/.env.prod"
$C exec backup ls -lh /backups
$C exec backup sh -c 'pg_restore --clean --if-exists -d "$PGDATABASE" /backups/kaluch-AAAAMMDD-HHMMSS.dump'
```
Desde Google Drive (por ejemplo, en un servidor nuevo): instala con `bootstrap-vps.sh` y ejecuta
`setup-gdrive.sh` con las contraseñas guardadas, en lugar de generar unas nuevas:
```bash
CRYPT_PASSWORD='...' CRYPT_SALT='...' bash docker/setup-gdrive.sh
$C run --rm --entrypoint rclone backup ls kaluch-cifrado:
$C run --rm --entrypoint rclone backup copy kaluch-cifrado:kaluch-AAAAMMDD-HHMMSS.dump /backups/
```
y después el `pg_restore` anterior.

## Seguridad aplicada

- HTTPS obligatorio con HSTS y cabeceras de seguridad (Caddy).
- 2FA obligatorio para Superadministrador y Contador (`AUTH_ENFORCE_2FA=true`).
- Contenedores sin root; PostgreSQL sin puerto público; secretos solo en el servidor (`docker/.env.prod`, permisos 600).
- Cortafuegos con solo los puertos 22, 80 y 443.
- Recomendado: en Hostinger → *Seguridad*, añadir tu clave SSH y desactivar el acceso por contraseña de root.
