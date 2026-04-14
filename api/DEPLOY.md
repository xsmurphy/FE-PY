# Deploy a Coolify (DigitalOcean)

Guía para levantar el API en producción usando Coolify self-hosted sobre un
droplet de DigitalOcean.

**Estado del código:** Fase 2 MVP completa, probada end-to-end en Docker
con Postgres + Redis + MinIO. Imagen de runtime incluye OpenJDK 17 para
la generación de KUDE. Tamaño final ~400 MB.

Ver [`../NEXT_STEPS.md`](../NEXT_STEPS.md) para el estado actualizado del
proyecto y la lista completa de bugs resueltos en la validación E2E.

## Requisitos previos

1. **Droplet DO** con Coolify instalado (mínimo 2 GB RAM, 2 vCPU)
2. **Dominio** apuntado al droplet (ej. `api.facturacion.com.py`)
3. **Certificado SSL** — Coolify lo genera automático con Let's Encrypt
4. **DB Postgres 16** — podés usar la managed de DO ($15/mes) o un contenedor
   en Coolify. Recomendado managed para evitar problemas de backup.
5. **Redis** — contenedor en Coolify alcanza (no hay datos persistentes críticos,
   solo colas y cache)
6. **S3-compatible** — MinIO self-hosted al principio, migrar a DO Spaces
   cuando el tráfico lo justifique

## Variables de entorno en Coolify

En **Settings → Environment Variables** de la app, configurar:

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

DATABASE_URL=postgres://user:pass@db-host:5432/facturacion?sslmode=require
REDIS_URL=redis://redis-host:6379

S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
S3_REGION=nyc3
S3_BUCKET=facturacion-prod
S3_ACCESS_KEY=<spaces_key>
S3_SECRET_KEY=<spaces_secret>
S3_FORCE_PATH_STYLE=false

# ⚠ CRÍTICO — generar ANTES del deploy y guardar backup offline
# node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
MASTER_KEY_BASE64=<32-bytes-base64>

# Flipear a true cuando haya certs reales de tenants
ENABLE_SIFEN=true

# KUDE (PDF visual) — requiere OpenJDK 17+ en el contenedor (ya incluido
# en el Dockerfile). Flipear a true cuando quieras generar los PDFs.
ENABLE_KUDE=true
JAVA_PATH=/usr/lib/jvm/default-jvm/bin/java

# Seguridad: NO dejar el playground expuesto en producción
# (todavía no gated — por ahora restringir vía reverse proxy / IP allowlist)
# ENABLE_PLAYGROUND=false

# Rate limiting (por API key prefix)
RATE_LIMIT_MAX=600
RATE_LIMIT_WINDOW_MS=60000

# CORS: en prod, limitar a los dominios de los clientes
CORS_ORIGINS=https://pos-cliente-a.com,https://admin.pos-cliente-a.com

# Cert expiration alerts
CERT_EXPIRATION_CHECK_INTERVAL_MS=86400000
CERT_EXPIRATION_WARNING_DAYS=30

SENTRY_DSN=<opcional>
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.1
```

### Alternativa con MinIO en Coolify

Si preferís no pagar Spaces al principio:

```
S3_ENDPOINT=http://minio-service:9000
S3_REGION=us-east-1
S3_BUCKET=facturacion-prod
S3_ACCESS_KEY=<generado en MinIO console>
S3_SECRET_KEY=<generado en MinIO console>
S3_FORCE_PATH_STYLE=true
```

Y agregás MinIO como otro servicio en el mismo proyecto de Coolify, con
persistent volume para `/data`.

## Configuración del servicio en Coolify

1. **New Resource → Application → Docker**
2. **Source**: GitHub repo `xsmurphy/FE-PY`, branch `main`
3. **Build Settings**:
   - Dockerfile path: `api/Dockerfile`
   - Build context: `/` (raíz del repo, NO `api/`)
   - Port: `3000`
4. **Domain**: `api.facturacion.com.py` (Coolify configura SSL automáticamente)
5. **Healthcheck**: `GET /v1/health` cada 30s
6. **Deploy**

La primera vez tarda **~10-15 min** porque la imagen incluye:
- Build del motor xmlgen (TS 3.7 → dist)
- Build del API (TS 5 → dist)
- Instalación de `openjdk17-jre-headless` (~150 MB, para KUDE)
- `libxml2-utils` (xmllint para validación XSD)
- `tini` (init process)

La imagen resultante pesa ~400 MB. Después del primer build, los
rebuilds incrementales tardan ~1-2 min gracias al cache de Docker layers.

### URLs expuestas después del deploy

- `https://api.facturacion.com.py/v1/health` — health check
- `https://api.facturacion.com.py/docs` — Swagger UI
- `https://api.facturacion.com.py/v1/*` — endpoints del API
- `https://api.facturacion.com.py/playground` — **⚠ tapar con reverse proxy
  o IP allowlist en producción**, es una UI de testing sin auth

## Servicios adicionales

Recomiendo crear estos servicios aparte en Coolify:

### Redis
- Image: `redis:7-alpine`
- Persistent volume: `/data`
- No expuesto públicamente

### Worker (Batch 7)
- Mismo repo y Dockerfile que el API
- Override command: `["worker"]`
- Variables de entorno idénticas al API
- Sin puerto expuesto
- Scale: empezar con 1 replica, escalar según carga

## Backups

### Base de datos
Si usás Postgres managed de DO, los backups automáticos están incluidos
($15/mes para db-s-1vcpu-1gb). Configurar retención 7 días mínimo.

Si usás contenedor, agregar un cron job que haga `pg_dump` diario y lo suba
al bucket S3:

```sh
#!/bin/sh
pg_dump "$DATABASE_URL" | gzip | aws s3 cp - "s3://facturacion-backups/$(date +%F).sql.gz"
```

### MASTER_KEY_BASE64 — CRÍTICO

**Si se pierde esta clave, todos los certificados de todos los tenants quedan
inaccesibles** y no se pueden recuperar. Acciones obligatorias:

1. **Antes del deploy**, guardar la clave en al menos **3 lugares offline**:
   - Gestor de passwords personal (1Password, Bitwarden, etc.)
   - Sobre físico en caja fuerte
   - Archivo cifrado en storage externo (no en el mismo DO)
2. **Rotar semestralmente** con un procedimiento de re-cifrado:
   - Generar nueva KEK
   - Descargar todos los bundles cifrados
   - Descifrar DEKs con KEK vieja, re-cifrar con KEK nueva
   - Atomic swap en DB
   - Mantener KEK vieja disponible 24h por si hay que rollback

## CI/CD

GitHub Actions corre en cada push a `main`:
- Typecheck, tests, build del API
- Build de la imagen Docker
- No pushea al registry — Coolify lo hace al detectar el push

Coolify detecta el push a `main` vía webhook y rebuilda automáticamente.
Podés configurar **auto-deploy** o **manual approval** según prefieras.

## Troubleshooting

### El contenedor no arranca
Revisar logs en Coolify. Causas típicas:
- Falta `MASTER_KEY_BASE64` o tiene longitud incorrecta (debe decodificar a 32 bytes)
- `DATABASE_URL` mal escrito (falta `?sslmode=require` en managed DBs)
- Migrations fallaron — correr `docker compose run api migrate` para ver el error
- Si usás postgres local bajo Coolify, asegurate que el port forwarding del
  compose NO conflicte con tu postgres local (el compose de dev usa 5433, 6380,
  9100, 9101 por esa razón)

### Errores conocidos de la primera corrida (ya fixeados)
Si estás revisando un commit viejo, los siguientes bugs ya fueron resueltos
en `9938878` — si alguno vuelve a aparecer, es regression:
1. `Cannot find module 'facturacionelectronicapy-xmlgen'` → Dockerfile paths
2. `tsc: not found` durante npm install → prepare script del motor
3. `Cannot find module 'xml2js'` → node_modules del motor no copiado
4. `Key (cdc)=() already exists` → cdc=string vacío en lugar de null
5. Errores del motor devolvían 500 en vez de 422 → sin try/catch explícito
6. `Falta el Timbrado en data.timbrado` en inutilización → campo no documentado

### SIFEN está caído
Con `ENABLE_SIFEN=true`, si SIFEN test/prod está caído las emisiones
sincrónicas van a timeout. Workarounds:
- Poner `ENABLE_SIFEN=false` temporalmente (los clientes pueden emitir
  localmente, los enviamos después)
- Con Batch 7 (queue async), los documentos se encolan y reintentan
  automáticamente cuando SIFEN vuelve

### Certificados expirando
Agregar un cron job diario (Batch 7+) que consulte `tenant_certs` por certs
con `notAfter < NOW() + INTERVAL '30 days'` y envíe email de alerta a la
company.

## Monitoring

- **Sentry**: configurar `SENTRY_DSN` en env vars para tracking de errores
- **Grafana + Prometheus**: Coolify tiene integración nativa
- **Uptime**: healthcheck automático en Coolify + pingdom/uptime-robot externo

## Escalado

Para alta concurrencia (1K+ facturas/minuto):
1. Scale el API horizontalmente en Coolify (replicas)
2. Aumentar pool de conexiones Postgres (`DATABASE_URL?connection_limit=20`)
3. Redis en modo cluster si queue tiene >10K jobs/min
4. Considerar separar Postgres read-replicas para queries de listado

Empezar con 1 replica de API + 1 worker y escalar desde ahí según métricas.
