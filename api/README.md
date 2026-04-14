# facturacion-api

API comercial multi-tenant de facturación electrónica Paraguay (SIFEN).
Motor bajo el capó: [`facturacionelectronicapy-xmlgen`](../) (carpeta raíz
del repo, consumido vía `file:..`).

**Estado:** Fase 2 MVP completa y validada end-to-end contra Postgres + Redis
+ MinIO en Docker. Lo único que falta es cert `.p12` real de SIFEN.

Para la foto completa del proyecto, leer [`../NEXT_STEPS.md`](../NEXT_STEPS.md).

## Features implementadas

- **Fastify 5 + TypeScript + Drizzle + Postgres 16**
- **Multi-tenancy 2 niveles** (Company → Tenant) con aislamiento estricto
- **Envelope encryption AES-256-GCM** (KEK/DEK) para certs y CSC
- **Pipeline completo de emisión**: xmlgen → validación XSD → xmlsign → qrgen → setapi → S3
- **5 tipos de documento**: FE (1), Autofactura (4), NC (5), ND (6), NR (7)
- **Eventos**: cancelación + inutilización
- **Idempotency** con caché en Postgres (TTL 24h)
- **Numeración por tenant** con `SELECT FOR UPDATE` atómico
- **Batch async** con BullMQ + workers
- **Retry automático** ante errores transitorios de SIFEN
- **Rate limiting** por API key prefix (sin DB lookup)
- **Audit logging** fire-and-forget a `api_logs`
- **Cert expiration alerts** con cron interno (24h)
- **OpenAPI/Swagger UI** en `/docs` con 29 endpoints documentados
- **Playground HTML** en `/playground` para probar sin Postman
- **Sentry** para error tracking (opcional)
- **KUDE (PDF)** — implementado, pendiente de probar con cert real

## Tests

```bash
npm test              # 42 tests pasando
npm run test:watch    # watch mode
```

Tests existentes:
- `test/crypto/envelope.test.ts` (12) — AES-256-GCM round trip, tampering, KEK rotation
- `test/services/cert.service.test.ts` (17) — parseP12, envelope, regression round-trip DB
- `test/lib/cdc.test.ts` (8) — extract, format validation, random seguro
- `test/services/csc.service.test.ts` (5) — envelope del CSC

## Quickstart (Docker, recomendado)

**Prerequisitos:** Docker Desktop. En macOS si `docker` no está en PATH, agregá
`/Applications/Docker.app/Contents/Resources/bin` al PATH.

```bash
# Desde la raíz del repo (NO desde api/)
cd /ruta/a/FE-PY

# Generar MASTER_KEY (o usar una fija para dev)
export MASTER_KEY_BASE64="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"

# Build + up
docker compose -f api/docker-compose.yml up --build
```

**Puertos expuestos** (elegidos para no conflictar con instancias locales):

| Servicio | Puerto | URL |
|---|---|---|
| API | 3000 | http://localhost:3000 |
| Playground UI | 3000 | http://localhost:3000/playground |
| Swagger | 3000 | http://localhost:3000/docs |
| Postgres | 5433 | `postgres://postgres:postgres@localhost:5433/facturacion` |
| Redis | 6380 | `redis://localhost:6380` |
| MinIO API | 9100 | http://localhost:9100 |
| MinIO Console | 9101 | http://localhost:9101 (minioadmin/minioadmin) |

## Quickstart (sin Docker, deps en Docker)

Si preferís desarrollar con tsx watch:

```bash
cd api

# Copiar env de ejemplo
cp .env.example .env
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
# Editar .env y setear MASTER_KEY_BASE64=$KEY

# Levantar solo deps (postgres, redis, minio) desde el root del repo
cd ..
docker compose -f api/docker-compose.yml up -d postgres redis minio minio-init

# Volver a api/ y correr en dev mode
cd api
npm install
npm run db:generate   # genera migrations SQL desde schema.ts
npm run db:migrate    # aplica migrations
npm run dev           # tsx watch, reload automático
```

Ajustar los puertos en `.env`:
```
DATABASE_URL=postgres://postgres:postgres@localhost:5433/facturacion
REDIS_URL=redis://localhost:6380
S3_ENDPOINT=http://localhost:9100
```

## Probar la API

### Opción A: Playground UI (la más fácil)

Abrir http://localhost:3000/playground en el navegador.

Es un HTML standalone con formularios pre-llenados para cada paso:
signup → tenant → upload cert → CSC → emitir → cancelar → listar.
El estado (API key, tenant ID) se persiste en localStorage.

### Opción B: curl

```bash
# 1. Signup
SIGNUP=$(curl -s -X POST http://localhost:3000/v1/companies \
  -H 'content-type: application/json' \
  -d '{"name":"Test Co","email":"admin@test.com"}')
API_KEY=$(echo "$SIGNUP" | jq -r .apiKey)

# 2. Perfil
curl http://localhost:3000/v1/companies/me \
  -H "authorization: Bearer $API_KEY"

# 3. Listar endpoints disponibles
curl http://localhost:3000/docs/json | jq '.paths | keys'
```

### Opción C: Swagger UI

http://localhost:3000/docs — incluye el botón "Authorize" para setear el
Bearer token y probar cada endpoint desde el browser.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | tsx watch, reload on change |
| `npm run worker:dev` | tsx watch del worker BullMQ |
| `npm run build` | TypeScript → `dist/` |
| `npm start` | corre `dist/server.js` |
| `npm run start:worker` | corre `dist/queue/worker-server.js` |
| `npm run typecheck` | tsc --noEmit |
| `npm run db:generate` | genera migración SQL desde `schema.ts` |
| `npm run db:migrate` | aplica migraciones pendientes |
| `npm run db:studio` | abre Drizzle Studio |
| `npm test` | Vitest one-shot |
| `npm run test:watch` | Vitest watch |

## Variables de entorno

Ver [`.env.example`](.env.example). Las más críticas:

| Variable | Descripción |
|---|---|
| `MASTER_KEY_BASE64` | **KEK master de 32 bytes.** Si se pierde, todos los certs quedan inaccesibles. Backup offline obligatorio. |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `S3_*` | Endpoint, bucket, credentials de MinIO/Spaces |
| `ENABLE_SIFEN` | `false` = skip firma+envío. `true` = pipeline completo |
| `ENABLE_KUDE` | `false` por default. `true` requiere Java runtime en el container |
| `CORS_ORIGINS` | `*` o lista CSV |
| `RATE_LIMIT_MAX` | 600 req/min por API key (default) |
| `SENTRY_DSN` | Opcional, inicializa Sentry si está set |

## Arquitectura

### Pipeline de emisión (`POST /v1/tenants/:id/de`)

```
  request
     │
     ├─ requireAuth       → company_id from Bearer
     ├─ requireTenantScope → tenant_id from path, 404 si no matchea
     ├─ idempotencyCheck  → cache hit? devolver respuesta previa
     │
     ▼
  BEGIN TX
    SELECT FOR UPDATE numeracion
    INSERT documents (cdc=null, estado='generando')
  COMMIT
     │
     ▼
  xmlgen.generateXMLDE(params, data)   ← motor
     │
     ▼
  validatePreSigning (xmllint vs xsd-unsigned/)
     │
     ├─ if ENABLE_SIFEN:
     │    decryptCertBundle (envelope)
     │    xmlsign.signXML
     │    validatePostSigning (xmllint vs xsd/)
     │    qrgen.generateQR (si hay CSC)
     │    kude.generateKudePdf (si ENABLE_KUDE)
     │
     ▼
  upload XML a S3 (MinIO/Spaces)
     │
     ├─ if ENABLE_SIFEN:
     │    setapi.recibe → SIFEN SOAP
     │    parse response → estado aprobado/rechazado
     │    if transient error: enqueue sifen-retry job
     │
     ▼
  UPDATE documents (cdc, xml_storage_key, estado, sifen_response_raw)
     │
     └─ onSend: idempotencyPersist (cache 2xx en DB)
     └─ onResponse: auditLog (fire-and-forget)
```

### 9 tablas DB

Ver [`src/db/schema.ts`](src/db/schema.ts):

| Tabla | Notas |
|---|---|
| `companies` | UUID v7, API key sha256 hasheado, prefix indexable |
| `tenants` | unique `(company_id, ruc)`, config del emisor |
| `tenant_certs` | envelope encryption (p12 + password + DEK única) |
| `tenant_csc` | CSC cifrado (1 por tenant) |
| `documents` | **cdc nullable** durante generación, unique `(tenant, tipo, est, punto, numero)` |
| `numeracion` | PK compuesta, `SELECT FOR UPDATE` en cada insert |
| `eventos` | cancelación + inutilización (cdc nullable para inutilización) |
| `idempotency_keys` | TTL 24h, cache de responses 2xx, GC automático |
| `api_logs` | audit trail fire-and-forget |

## Diseño de secretos (envelope encryption)

Los certificados `.p12` nunca se guardan en claro. Ver [`src/crypto/envelope.ts`](src/crypto/envelope.ts):

1. **Master KEK** (`MASTER_KEY_BASE64`, 32 bytes) — en env var, nunca se serializa
2. **DEK por cert** (32 bytes random) — generada al subir el `.p12`
3. **Cifrado AES-256-GCM** con IV random de 12 bytes + tag auth de 16 bytes
4. **Storage en DB:** `{ciphertext, iv, tag}` para el `.p12` + para el password,
   más `{encryptedDek, ivDek, tagDek}` donde la DEK está cifrada con la KEK

**Al firmar:** se descifra la DEK con la KEK, luego el `.p12` y password con la DEK,
se escribe el p12 a un tmpfile con perms 0600, se llama `xmlsign.signXML`, se
borra el tmpfile y se zero-ean los buffers en memoria.

**Si se pierde la KEK, todos los certs quedan inaccesibles.** Backup offline triple
obligatorio antes del deploy a producción.

## Bugs conocidos / limitaciones actuales

### No testeado (requiere cert real)

- `xmlsign.signXML` con cert `.p12` del portal ekuatia
- Validación XSD estricta post-firma
- Envío a SIFEN vía `setapi.recibe`
- QR generado con CSC real
- KUDE (PDF) completo — el módulo tiene APIs inconsistentes y requiere Java
- Calibración de códigos SIFEN (`0260/1001/1002` son placeholders)

### Historial de bugs encontrados en la validación E2E Docker

Se encontraron y arreglaron 6 bugs en el primer arranque real. Ver
[`../NEXT_STEPS.md`](../NEXT_STEPS.md#bugs-encontrados-durante-la-validación-e2e)
para el detalle. TL;DR: Dockerfile paths, prepare script, xml2js faltante,
cdc='' violando UNIQUE, errores del motor como 500 en vez de 422, y
`data.timbrado` no documentado en inutilización.

## Deploy a producción

Ver [`DEPLOY.md`](DEPLOY.md) para la guía completa a Coolify + DigitalOcean.

## Referencias

- [NEXT_STEPS.md](../NEXT_STEPS.md) — documento maestro del proyecto
- [PLAN.md](../PLAN.md) — plan detallado
- [DEPLOY.md](DEPLOY.md) — guía de deploy
- [.env.example](.env.example) — todas las env vars comentadas
- Motor xmlgen upstream: [README.md](../README.md)
