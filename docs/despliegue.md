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

```bash
cd /opt/kaluch && BRANCH=main bash docker/bootstrap-vps.sh
```
Descarga la rama, reconstruye las imágenes y aplica las migraciones de base de datos al arrancar la
API. No borra datos.

## Cargar los datos reales del Excel

```bash
mkdir -p /opt/kaluch-data && chmod 700 /opt/kaluch-data
# Sube el Excel desde tu ordenador:  scp "Balance de comprobación.xlsx" root@187.7.70.196:/opt/kaluch-data/balance.xlsx
# Los contenedores se ejecutan sin privilegios (uid 1001): la carpeta debe ser suya.
chown -R 1001 /opt/kaluch-data && chmod 600 /opt/kaluch-data/*.xlsx
cd /opt/kaluch
C="docker compose -f docker/compose.prod.yml --env-file docker/.env.prod run --rm -v /opt/kaluch-data:/data api node packages/etl/dist/cli.js"
$C all /data/balance.xlsx                     # plan de cuentas, tasas y valores de referencia del BC
$C treasury /data/balance.xlsx                # caja y bancos: apertura 31/03/2026, movimientos, revaluaciones (~8 min)
$C compare /data/conciliacion.xlsx            # informe de conciliación con el BC
```
La migración de tesorería se ejecuta **una sola vez** sobre una base recién importada.

## Copias de seguridad

- **Diarias** (`pg_dump`, formato custom), en el volumen `backups`, con 30 días de retención.
- **Instantáneas semanales del VPS** desde el panel de Hostinger (*Backups y monitoreo*). Conviene
  activarlas.
- **Copia fuera del servidor (recomendado):** sincronizar el volumen de copias con un almacenamiento
  externo (Backblaze B2, S3 o Google Drive con `rclone`). Hace falta crear la cuenta de destino: dime
  cuál prefieres y lo dejo configurado.

Restaurar una copia:
```bash
cd /opt/kaluch
docker compose -f docker/compose.prod.yml --env-file docker/.env.prod exec backup ls -lh /backups
docker compose -f docker/compose.prod.yml --env-file docker/.env.prod exec backup \
  pg_restore --clean --if-exists -d "$POSTGRES_DB" /backups/kaluch-AAAAMMDD-HHMMSS.dump
```

## Seguridad aplicada

- HTTPS obligatorio con HSTS y cabeceras de seguridad (Caddy).
- 2FA obligatorio para Superadministrador y Contador (`AUTH_ENFORCE_2FA=true`).
- Contenedores sin root; PostgreSQL sin puerto público; secretos solo en el servidor (`docker/.env.prod`, permisos 600).
- Cortafuegos con solo los puertos 22, 80 y 443.
- Recomendado: en Hostinger → *Seguridad*, añadir tu clave SSH y desactivar el acceso por contraseña de root.
