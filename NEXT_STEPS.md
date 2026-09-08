# Facturación Electrónica Paraguay — Estado, Funcionamiento y Próximos Pasos

Documento maestro del proyecto. Si es la primera vez que abrís este repo,
leé este archivo de punta a punta antes de tocar código.

**Última actualización:** commit `b51aaa1` — 2026-04-14

---

## Tabla de contenidos

1. [Qué es este repo](#qué-es-este-repo)
2. [Estado REAL del código (verificado en Docker)](#estado-real-del-código-verificado-en-docker)
3. [Arquitectura](#arquitectura)
4. [Cómo correrlo localmente](#cómo-correrlo-localmente)
5. [Playground UI para probar rápido](#playground-ui-para-probar-rápido)
6. [Los 30 endpoints del API](#los-30-endpoints-del-api)
7. [Flujo completo para un cliente integrador](#flujo-completo-para-un-cliente-integrador)
8. [Variables de entorno](#variables-de-entorno)
9. [Lo que falta para producción](#lo-que-falta-para-producción)
10. [Bugs encontrados durante la validación E2E](#bugs-encontrados-durante-la-validación-e2e)
11. [Roadmap post-MVP](#roadmap-post-mvp)
12. [Referencias a otros documentos](#referencias-a-otros-documentos)

---

## Qué es este repo

Este repo contiene **dos proyectos en uno** bajo un monorepo:

### 1. Motor `facturacionelectronicapy-xmlgen` (raíz)

Módulo open source Node/TypeScript que **genera XML SIFEN v150** a partir de
un JSON con los datos del documento. Es un fork/clone del proyecto original
de Marcos Jara (licencia MIT).

- Código: [src/](src/)
- Build: [dist/](dist/) (compilado con TS 3.7)
- XSDs oficiales descargados: [xsd/](xsd/) + [xsd-unsigned/](xsd-unsigned/)
- README del motor: [README.md](README.md)
- Formulario de prueba local del motor: [test-ui.js](test-ui.js) en http://localhost:3100

### 2. API comercial `facturacion-api` ([api/](api/))

Servicio REST multi-tenant que envuelve al motor y lo ofrece como SaaS.
**Este es el producto**. Acepta que clientes suban su certificado digital,
emiten documentos electrónicos vía HTTP, y todo queda persistido con
audit trail.

- Código: [api/src/](api/src/)
- Tests: [api/test/](api/test/) — **42 tests pasando**
- README del API: [api/README.md](api/README.md)
- Guía de deploy: [api/DEPLOY.md](api/DEPLOY.md)

**Todo este documento se refiere a `facturacion-api` salvo que diga lo contrario.**

---

## Estado REAL del código (verificado en Docker)

### ✅ Fase 2 MVP — 100% implementada + validada E2E contra SIFEN producción

**Actualización crítica 2026-09-07:** primera emisión real contra **SIFEN
producción** (no test) con cert `.p12` real de un cliente real (Balloon
Party, RUC 3595193-1). Facturas 001-002-0000612 (aprobada 0260, luego
anulada por evento 0600), 613 y 614 (protocolo `3549281396`) aprobadas; NC
001-002-0000002 (protocolo `3549281825`) aprobada; consulta WS calibrada.
Detalle completo, callejones sin salida y trampas conocidas en
`.claude/_handoff.md` (lectura de arranque de la próxima sesión).

**2026-04-14:** el stack completo se probó contra **Postgres + Redis + MinIO
reales** vía `docker compose up`. El pipeline funciona end-to-end con
`ENABLE_SIFEN=false` (emisión local sin envío a SIFEN). Se descubrieron y
arreglaron **6 bugs que los unit tests nunca podían haber atrapado**. Ver la
sección
[Bugs encontrados durante la validación E2E](#bugs-encontrados-durante-la-validación-e2e)
para el detalle.

### Historial de batches

| Batch | Qué agregó | Commit |
|---|---|---|
| 1 | Scaffolding + DB schema + envelope crypto | `c597536` |
| 2 | Tenants CRUD + cert service + storage | `0ab81d4` |
| 3 | DE síncrono + numeración + idempotency | `c824aaf` |
| 4 | CSC + download XML + consulta SIFEN | `1aaf8f2` |
| 5 | Cancelación de documentos | `05ce8fb` |
| 6 | Docker + CI + Coolify deploy guide | `10a90c1` |
| 7 | Queue async BullMQ + batch submission | `0dc04f1` |
| 8 | Sentry + Swagger + rate limit + audit + GC + consulta RUC | `9d7002a` |
| fix | Cert bundle DEK bug (seguridad) | `fafe319` |
| 9 | Preemptive fixes: UUID v7, rate limit por bearer, 204, etc. | `3e71e0f` |
| 10 | **KUDE + Inutilización + ND/Autofactura/NR + key rotation + cert cron** | `1aa972b` |
| E2E | **6 bugs encontrados en primer docker compose up** | `9938878` |
| UI | **Playground HTML en /playground** | `b51aaa1` |

### Métricas

```
lenguaje:         TypeScript (ESM, strict)
líneas de código: ~5.200 LOC en api/src/
endpoints:        30 (29 REST bajo /v1 + /playground HTML)
tablas DB:        9
tests unitarios:  42/42 pasando
dependencias:     ~400 paquetes npm
imagen Docker:    ~400 MB (con OpenJDK 17 para KUDE)
```

### Tests existentes (42/42)

Ver [api/test/](api/test/):

- **crypto/envelope.test.ts (12)** — AES-256-GCM round trip, tampering en 4 puntos, KEK rotation
- **services/cert.service.test.ts (17)** — parseP12, validación vigencia/RUC, envelope, regression test del round-trip DB
- **lib/cdc.test.ts (8)** — extract CDC, format validation, random seguro
- **services/csc.service.test.ts (5)** — envelope del CSC

### Probado end-to-end contra infra real (Docker)

| Feature | Estado |
|---|---|
| `POST /v1/companies` — signup | ✓ Verificado |
| `POST /v1/tenants` — crear tenant con UUID v7 | ✓ Verificado |
| `POST /v1/tenants/:id/cert` — multipart `.p12` sintético | ✓ Verificado |
| `PUT /v1/tenants/:id/csc` — envelope encryption del CSC | ✓ Verificado |
| `POST /v1/tenants/:id/de` — emisión con idempotency | ✓ Verificado |
| `SELECT FOR UPDATE` numeración bajo concurrencia | ✓ Verificado |
| Validación XSD pre-firma con `xmllint` | ✓ Verificado |
| Upload del XML a MinIO | ✓ Verificado |
| Presigned URLs con AWS4-HMAC-SHA256 | ✓ Verificado |
| Idempotency key caché en Postgres | ✓ Verificado |
| `POST /v1/tenants/:id/eventos/cancelacion` | ✓ Verificado |
| `POST /v1/tenants/:id/eventos/inutilizacion` | ✓ Verificado |
| **XML generado valida contra `xsd-unsigned/siRecepDE_v150.xsd`** | ✓ **Crítico — verificado** |

### Ya probado contra SIFEN producción real (2026-09-07)

`xmlsign.signXML` con cert real, envío por `recibeLote`+`consultaLote`
(no `recibe` síncrono — restringido en prod, ver Blockers), QR con CSC
real, KUDE PDF, cancelación (evento 0600), NC, consulta WS (`0422`). Ver
`.claude/_handoff.md` para protocolos y detalle.

### NO probado todavía

| Feature | Por qué no |
|---|---|
| Inutilización de numeración | No ejercitado esta sesión |
| ND / Autofactura / remisión | No ejercitado esta sesión |
| Batch async (BullMQ) + retry worker | Worker no corre en el compose local (profile "workers" apagado) |
| Receptor con CI sin RUC | No ejercitado esta sesión |
| Emisión real desde prod (fepy.punto.la) | Bloqueada por `timbradoFecha` mal cargada, ver Blockers |

---

## Arquitectura

### Modelo de multi-tenancy (2 niveles)

```
Company A ── "POS Retail SaaS" ── cmp_key_abc... (API key master)
├── Tenant A1 (RUC 80012345-1, "Panadería Elsa")
│   ├── cert_A1.p12 (cifrado en DB con envelope encryption)
│   ├── CSC del portal ekuatia
│   ├── Documento #001 → CDC 01800...
│   └── Documento #002 → CDC 01800...
└── Tenant A2 (RUC 80099999-3, "Ferretería Central")

Company B ── "Restaurantes Manager" ── cmp_key_xyz...
└── Tenant B1 (RUC 80055555-7, "Parrilla Fuego")
```

**Reglas de aislamiento** (enforced por [tenant-scope middleware](api/src/middleware/tenant-scope.ts)):

- Company A **jamás** ve tenants, documentos, certs o errores de Company B
- Todas las queries filtran primero por `company_id`
- Acceso cross-company devuelve **404 (no 403)** para no revelar existencia
- Billing es **por company** (un solo bill consolidado)
- Numeración de facturas es **por tenant** (cada RUC tiene su propia secuencia)

### Stack técnico

| Capa | Tecnología |
|---|---|
| Runtime | Node 20 LTS + TypeScript 5 (ESM strict) |
| HTTP framework | Fastify 5 + `fastify-type-provider-zod` |
| Schema validation | zod |
| ORM | Drizzle + postgres-js |
| Base de datos | Postgres 16 (UUID v7 application-level, sin pgcrypto) |
| Cola de jobs | BullMQ + Redis 7 |
| Storage | MinIO (dev) / DO Spaces (prod) — S3-compatible |
| XSD validator | `xmllint` (libxml2 CLI) |
| KUDE (PDF) | `facturacionelectronicapy-kude` + OpenJDK 17 (gated `ENABLE_KUDE`) |
| Observabilidad | pino + Sentry + OpenAPI/Swagger UI |
| Contenedores | Docker multi-stage + Coolify |
| Tests | Vitest |

### Esquema de base de datos (9 tablas)

Ver [api/src/db/schema.ts](api/src/db/schema.ts):

| Tabla | Qué guarda |
|---|---|
| `companies` | Plataformas clientes (master API key hasheado) |
| `tenants` | Contribuyentes emisores (RUCs) |
| `tenant_certs` | Certificados `.p12` cifrados — una DEK compartida p12+password |
| `tenant_csc` | CSC cifrado por tenant |
| `documents` | Facturas/NC emitidas, XML en S3, **`cdc` nullable** para rows en progreso |
| `numeracion` | Secuencia por `(tenant, tipo, est, punto)` con `SELECT FOR UPDATE` |
| `eventos` | Cancelaciones + inutilizaciones |
| `idempotency_keys` | Cache de responses 2xx con TTL 24h |
| `api_logs` | Audit trail fire-and-forget |

---

## Cómo correrlo localmente

### Prerequisitos

- **Node 20+**
- **Docker Desktop** (en macOS el binary queda en
  `/Applications/Docker.app/Contents/Resources/bin/docker` — si no lo encontrás
  en el PATH, agregá esa ruta)
- El stack levanta en puertos **no-estándar** para no conflictar con tu entorno:
  - API: **3000**
  - Postgres: **5433** (no 5432)
  - Redis: **6380** (no 6379)
  - MinIO API: **9100**
  - MinIO Console: **9101**

### Arranque completo

```bash
# Desde la raíz del repo
cd /Users/xstian/Dropbox/Factura\ Electrónica/FE-PY

# Generar MASTER_KEY_BASE64 (o usar una fija para dev)
export MASTER_KEY_BASE64="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"

# Agregar Docker al PATH si hace falta
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

# Build + up (el primer build tarda ~10 min, después ~30s)
docker compose -f api/docker-compose.yml up --build
```

### Verificar que arrancó

```bash
curl http://localhost:3000/v1/health
# → {"status":"ok"}

curl http://localhost:3000/v1/health/ready
# → {"status":"ok","checks":{"database":"ok"}}

# Abrir en el browser:
# http://localhost:3000/playground     ← UI interactiva
# http://localhost:3000/docs           ← Swagger UI
# http://localhost:9101                ← MinIO console (minioadmin/minioadmin)
```

### Bajar el stack

```bash
docker compose -f api/docker-compose.yml down          # preserva volúmenes
docker compose -f api/docker-compose.yml down -v       # borra todo
```

---

## Playground UI para probar rápido

La forma más rápida de probar el API sin Postman ni curl:

**URL:** http://localhost:3000/playground

Es un HTML interactivo servido por el mismo Fastify (mismo origen → sin CORS).
Tiene forms pre-llenados para:

1. **Signup** de company — captura el API key automáticamente en localStorage
2. **Crear tenant** con defaults de Asunción
3. **Upload** del `.p12` con password
4. **Setear CSC**
5. **Emitir Factura** (tipoDocumento=1) con cliente + item + IVA
6. **Emitir Nota de Crédito** (tipoDocumento=5) con CDC asociado + motivo
7. **Cancelar** un DE emitido
8. **Inutilizar rango** de numeración
9. **Listar** documentos y eventos del tenant

El estado (`company_id`, `api_key`, `tenant_id`) se persiste en localStorage
del navegador. Botón "Resetear estado local" para empezar de cero.

**⚠️ No exponer en producción** — solo dev/staging. Gating por env var pendiente.

---

## Los 30 endpoints del API

**Documentación interactiva:** http://localhost:3000/docs (Swagger UI)
**OpenAPI JSON:** http://localhost:3000/docs/json

### Públicos (sin auth)

```
POST   /v1/companies                              signup → API key
GET    /v1/health                                 liveness
GET    /v1/health/ready                           readiness (chequea DB)
GET    /playground                                UI HTML interactiva
GET    /docs                                      Swagger UI
GET    /docs/json                                 OpenAPI spec
```

### Company (auth)

```
GET    /v1/companies/me                           perfil
POST   /v1/companies/me/keys/rotate               rotar API key
```

### Tenants

```
POST   /v1/tenants                                crear
GET    /v1/tenants                                listar paginado
GET    /v1/tenants/:tenant_id                     detalle
PATCH  /v1/tenants/:tenant_id                     actualizar
DELETE /v1/tenants/:tenant_id                     suspender
```

### Certificados (`.p12`)

```
POST   /v1/tenants/:tenant_id/cert                upload multipart
GET    /v1/tenants/:tenant_id/cert                metadata (nunca el blob)
DELETE /v1/tenants/:tenant_id/cert                revocar
```

### CSC (Código de Seguridad del Contribuyente)

```
PUT    /v1/tenants/:tenant_id/csc                 set/rotate
GET    /v1/tenants/:tenant_id/csc                 metadata
DELETE /v1/tenants/:tenant_id/csc                 eliminar
```

### Documentos electrónicos (tipos 1, 4, 5, 6, 7)

```
POST   /v1/tenants/:tenant_id/de                  emitir
       headers: Idempotency-Key <string>
GET    /v1/tenants/:tenant_id/de                  listar paginado
GET    /v1/tenants/:tenant_id/de/:cdc             detalle + presigned URL
GET    /v1/tenants/:tenant_id/de/:cdc/xml         download directo del XML
GET    /v1/tenants/:tenant_id/de/:cdc/kude        download del PDF KUDE
POST   /v1/tenants/:tenant_id/de/:cdc/consulta    re-consultar SIFEN
```

**Tipos soportados:** FE (1), Autofactura (4), NC (5), ND (6), Remisión (7).

### Emisión por lotes (async con BullMQ)

```
POST   /v1/tenants/:tenant_id/de/batch            hasta 500 docs
GET    /v1/tenants/:tenant_id/de/batch/:batch_id  estado agregado
```

### Eventos SIFEN

```
POST   /v1/tenants/:tenant_id/eventos/cancelacion
POST   /v1/tenants/:tenant_id/eventos/inutilizacion
GET    /v1/tenants/:tenant_id/eventos             listar (filtro por CDC)
```

### Consultas SIFEN (read-only)

```
GET    /v1/tenants/:tenant_id/consulta/ruc/:ruc   consultar info de un RUC
```

---

## Flujo completo para un cliente integrador

Ver el [playground](#playground-ui-para-probar-rápido) para probarlo
clickando, o ejecutar con curl:

```bash
# 1. Signup → API key
SIGNUP=$(curl -s -X POST http://localhost:3000/v1/companies \
  -H 'content-type: application/json' \
  -d '{"name":"Acme POS","email":"admin@acme.com"}')
API_KEY=$(echo "$SIGNUP" | jq -r .apiKey)

# 2. Crear tenant
TENANT=$(curl -s -X POST http://localhost:3000/v1/tenants \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d @tenant-fixture.json)
TENANT_ID=$(echo "$TENANT" | jq -r .id)

# 3. Subir certificado .p12
curl -X POST http://localhost:3000/v1/tenants/$TENANT_ID/cert \
  -H "authorization: Bearer $API_KEY" \
  -F "file=@/ruta/al/Certificado.p12" \
  -F "password=tu_password"

# 4. Configurar CSC
curl -X PUT http://localhost:3000/v1/tenants/$TENANT_ID/csc \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"cscId":"1","csc":"ABCD1234..."}'

# 5. Emitir factura (idempotent)
curl -X POST http://localhost:3000/v1/tenants/$TENANT_ID/de \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" \
  -d @factura-fixture.json
# → {txnId, cdc, estado, xmlUrl, signed, sentToSifen, ...}
```

---

## Variables de entorno

Ver [api/.env.example](api/.env.example) para el archivo completo.

### Críticas

| Variable | Descripción |
|---|---|
| `MASTER_KEY_BASE64` | **KEK master de 32 bytes. Si se pierde, todos los certs quedan inaccesibles.** Backup offline obligatorio. |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `S3_*` | Endpoint, bucket, credentials de MinIO o DO Spaces |
| `ENABLE_SIFEN` | `false` = skip firma+envío. `true` = pipeline completo |
| `ENABLE_KUDE` | `false` = no generar PDF. `true` = generar KUDE (requiere Java runtime) |
| `JAVA_PATH` | Path al Java executable (default `/usr/lib/jvm/default-jvm/bin/java` en Alpine) |

### Operacionales

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | 3000 | Puerto HTTP |
| `LOG_LEVEL` | `info` | pino: trace/debug/info/warn/error/fatal |
| `CORS_ORIGINS` | `*` | Lista CSV o `*` |
| `RATE_LIMIT_MAX` | 600 | Requests permitidas en la ventana |
| `RATE_LIMIT_WINDOW_MS` | 60000 | Ventana del rate limit |
| `IDEMPOTENCY_GC_INTERVAL_MS` | 3600000 | Frecuencia del GC |
| `CERT_EXPIRATION_CHECK_INTERVAL_MS` | 86400000 | Frecuencia del check de certs (24h) |
| `CERT_EXPIRATION_WARNING_DAYS` | 30 | Umbral de alerta |
| `ENABLE_API_DOCS` | `true` | Expone `/docs` |
| `SENTRY_DSN` | (vacío) | Si se setea, inicializa Sentry |
| `SENTRY_ENVIRONMENT` | `development` | Tag en Sentry |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | 10% de traces |

---

## Lo que falta para producción

### 🔴 Blockers (sin esto no se deploya)

Resuelto 2026-09-08: **API deployada y en producción en
[https://fepy.punto.la](https://fepy.punto.la)** — Coolify en el server de
Punto (167.71.165.221), Postgres+Redis propios en el mismo Coolify, TLS/
health/DB ok, `/playground` gated (404), provisioning prod ejecutado
(tenant Balloon Party, cert, CSC, numeración FE=614/NC=2). Auto-deploy por
push desactivado; deploys manuales. Detalle completo en `.claude/_handoff.md`.
Queda:

- [ ] **🔴 BLOCKER: `timbradoFecha` del tenant prod mal cargada** (2026-02-06,
  la real es 2025-08-26) — toda emisión rebota 1107 hasta corregirla, ver
  `.claude/_handoff.md` → Próximo paso
- [ ] **Worker BullMQ en Coolify** (duplicar app, start command `worker`) — sin él no hay retries ni batch async
- [ ] **Hand-off de credenciales a Punto** (`fepy-handoff.json`) para el flip de `FePyProvider`
- [ ] **Emisión de prueba desde prod** para validar el pipeline en el server
- [ ] **`MASTER_KEY_BASE64` prod** ya generada y cargada en Coolify — falta backup offline triple (quedó impresa en el terminal del owner, limpiar historial)
- [ ] **Droplet propio DO** — bloqueado por saldo pendiente en la cuenta del owner; hoy corre en el server de Punto como hosting temporal

### 🟡 Mejoras recomendadas antes del primer cliente

- [ ] Tests de integración contra Postgres + Redis reales (CI con docker)
- [ ] Postman collection para entregar a los devs de los clientes
- [ ] Dev portal con docs públicas (Docusaurus o similar)
- [ ] Sentry DSN configurado + alerting de errores 5xx
- [ ] Métricas Prometheus + Grafana

### 🟢 Nice-to-have post-lanzamiento

- [ ] Otros eventos SIFEN (conformidad, disconformidad, etc.)
- [ ] Webhooks por company (firmados con HMAC)
- [ ] Panel admin web (Next.js)
- [ ] OpenTelemetry tracing

### 🔵 Negocio (no código)

- [ ] Modelo de pricing
- [ ] Sistema de billing
- [ ] Landing page + signup público
- [ ] Términos de servicio + privacy policy (ley 6534/2020 PY)
- [ ] SLA + página de status
- [ ] Canal de soporte

---

## Bugs encontrados durante la validación E2E

Al arrancar por primera vez el stack completo en Docker, se encontraron y
arreglaron **6 bugs** que los unit tests nunca hubieran atrapado. Todos
están fixeados en commits `9938878` y `b51aaa1`. Los documento porque
son el tipo de cosas que vuelven a pasar en nuevos módulos del pipeline.

**2026-09-07 (contra SIFEN producción real):** +7 hallazgos duros más
(timezone en firma/dFeEmiDE, timbradoFecha nunca estimado, `recibe`
síncrono restringido en prod, NC exige receptor identificado, KUDE en dos
capas — JRE sin fontconfig + nombre de PDF del JAR, `dProtConsLote` de 19
dígitos, fila muerta en `documents` tras rechazo). Detalle completo en
`.claude/_handoff.md` — no repetido acá porque no son bugs de código sino
comportamiento real de SIFEN, y viven mejor junto al resto del contexto de
esa sesión.

### #1 — Dockerfile paths inconsistentes

**Síntoma:** `Cannot find module 'facturacionelectronicapy-xmlgen'` al arrancar.

**Causa:** El Dockerfile ponía el motor en `/parent/` pero `api/package.json`
usa `"file:.."` que desde `/app/api` resuelve a `/app/`, y `xsd-validator.ts`
resuelve XSDs vía `../../..` que también espera `/app/`.

**Fix:** Layout `/app/` + `/app/api/` que replica el del repo real.

### #2 — Prepare script del motor falla sin devDeps

**Síntoma:** `tsc: not found` durante `npm install` en el api-builder.

**Causa:** `"file:.."` dispara el lifecycle `prepare` del motor (que es
`npm run build` → `tsc`), pero TypeScript no está instalado. `--ignore-scripts`
no aplica a deps `file:`.

**Fix:** Strip de `prepare/prepublishOnly/preversion/version/postversion` del
package.json del motor antes del `npm install` del API, vía `node -e`.

### #3 — Runtime deps del motor faltantes (xml2js)

**Síntoma:** `Cannot find module 'xml2js'` al arrancar el server.

**Causa:** El Dockerfile copiaba `dist/` del motor pero no `node_modules/`.
El motor depende de `xml2js` en runtime y nadie lo instalaba.

**Fix:** `COPY --from=parent-builder /build/node_modules /app/node_modules`.

### #4 — `cdc=''` viola UNIQUE en inserts paralelos

**Síntoma:** `Key (cdc)=() already exists` al emitir el 2do documento.

**Causa:** `de.service.ts` insertaba con `cdc: ''` temporal antes de llamar
al motor. El `UNIQUE (cdc)` rechazaba el 2do insert con el mismo `''`.

**Fix:** Columna `cdc` nullable. Postgres permite múltiples NULL en UNIQUE,
así N documentos en estado `generando` en paralelo no conflictan.

### #5 — Errores del motor devolvían 500 en vez de 422

**Síntoma:** `{"error":{"code":"internal_error"}}` cuando el motor rechaza
por reglas de negocio (ej. `razonSocial` muy corto).

**Causa:** Los errores de `xmlgen.generateXMLDE()` llegaban al handler
general como 5xx sin exponer el mensaje útil.

**Fix:** `try/catch` explícito que re-envuelve como `ValidationError` (422)
con el mensaje del motor split por `;` en `details[]`.

### #6 — Inutilización requería `data.timbrado` no documentado

**Síntoma:** `Error: Falta el Timbrado en data.timbrado` al inutilizar rango.

**Causa:** El motor `generateXMLEventoInutilizacion` espera `timbrado` dentro
del body del evento, distinto de `params.timbradoNumero`. No documentado.

**Fix:** Pasar `timbrado: tenant.timbradoNumero` en el `eventoData` que va
a `xmlgen.generateXMLEventoInutilizacion`.

### Lecciones aprendidas

- **Los unit tests no reemplazan la validación E2E.** Los 42 tests unitarios
  pasaban perfecto — los 6 bugs solo aparecieron al armar el stack real.
- **Docker multi-stage con deps file:** tiene varias gotchas no triviales.
- **El motor xmlgen tiene algunas APIs no documentadas** — esperar más
  sorpresas cuando se active ENABLE_SIFEN y se conecte con cert real.

---

## Roadmap post-MVP

Una vez que tengas el primer cliente real emitiendo facturas en staging:

### Sprint 1 — Producto completo (2 semanas)

- Eventos restantes: conformidad, disconformidad, desconocimiento, notificación, nominación, actualización transporte
- Alerta automática de certs por vencer (email via Resend o similar, no solo log)
- KUDE realmente probado contra XML firmado
- Webhooks por company (HMAC signed)
- Tests de integración en CI con docker compose

### Sprint 2 — Escala (2-3 semanas)

- Panel admin web (Next.js) — dashboard, certs, logs, métricas
- Dev portal con docs públicas
- Postman collection + code samples
- Gating del playground para prod
- Métricas Prometheus + Grafana dashboards

### Sprint 3 — Operación (2 semanas)

- OpenTelemetry tracing con tenant_id/company_id
- Backups Postgres automáticos + restore probado
- Rotación semestral de KEK (script + procedimiento)
- Bull Board para inspección de jobs
- Rate limiting sofisticado por tier

### Sprint 4 — Comercialización (paralelo)

- Sistema de billing (Stripe / transferencia local)
- Quotas por tier
- Landing page + signup público
- Legal: TOS, Privacy Policy
- Page de status

---

## Referencias a otros documentos

| Documento | Qué contiene |
|---|---|
| [.claude/_handoff.md](.claude/_handoff.md) | **Lectura de arranque** — estado al cierre de la última sesión, callejones sin salida, próximo paso |
| [.claude/_session-log.md](.claude/_session-log.md) | Bitácora histórica de sesiones |
| [README.md](README.md) | Motor xmlgen original (upstream, Marcos Jara) |
| [PLAN.md](PLAN.md) | Plan detallado de fases con schema DB y endpoints |
| [api/README.md](api/README.md) | Quickstart del API |
| [api/DEPLOY.md](api/DEPLOY.md) | Guía de deploy a Coolify + DO |
| [api/.env.example](api/.env.example) | Todas las env vars comentadas |
| [api/src/db/schema.ts](api/src/db/schema.ts) | Schema DB completo |
| [api/src/app.ts](api/src/app.ts) | Entry point Fastify con todos los plugins |
| [api/src/routes/playground.ts](api/src/routes/playground.ts) | HTML del playground |

---

## Resumen en 5 líneas

1. **Todo el código del MVP comercial está hecho y verificado E2E en Docker real** con postgres+redis+minio. 42 unit tests + pipeline completo funcionando sin SIFEN activo.
2. **6 bugs descubiertos y arreglados** durante la primera corrida contra infra real (tipo de cosas que los unit tests no atrapan).
3. **Playground UI en `/playground`** para probar todo sin Postman, estado persistido en localStorage.
4. **El XML generado valida contra el XSD oficial SIFEN v150** — la misma validación que va a aplicar SIFEN al recibirlo.
5. **2026-09-07: primera emisión real validada contra SIFEN producción** (firma, envío por recibeLote/consultaLote, QR, KUDE, cancelación, NC, consulta) — lo que falta ahora es infraestructura de deploy (Coolify), no validación del motor. Detalle en `.claude/_handoff.md`.
