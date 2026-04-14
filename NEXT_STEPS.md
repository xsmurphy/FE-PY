# Facturación Electrónica Paraguay — Estado, Funcionamiento y Próximos Pasos

Documento maestro del proyecto. Si es la primera vez que abrís este repo,
leé este archivo de punta a punta antes de tocar código.

**Última actualización:** commit `fafe319` — 2026-04-14

---

## Tabla de contenidos

1. [Qué es este repo](#qué-es-este-repo)
2. [Arquitectura](#arquitectura)
3. [Estado actual del código](#estado-actual-del-código)
4. [Qué está probado y qué no](#qué-está-probado-y-qué-no)
5. [Cómo correrlo localmente](#cómo-correrlo-localmente)
6. [Endpoints del API](#endpoints-del-api)
7. [Flujo completo para un cliente integrador](#flujo-completo-para-un-cliente-integrador)
8. [Variables de entorno](#variables-de-entorno)
9. [Lo que falta para producción (checklist)](#lo-que-falta-para-producción-checklist)
10. [Plan de pruebas antes del primer cliente](#plan-de-pruebas-antes-del-primer-cliente)
11. [Bugs sospechosos pendientes de verificar](#bugs-sospechosos-pendientes-de-verificar)
12. [Roadmap post-MVP](#roadmap-post-mvp)
13. [Referencias a otros documentos](#referencias-a-otros-documentos)

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
- Formulario de prueba local (standalone): [test-ui.js](test-ui.js) — corre en http://localhost:3100

### 2. API comercial `facturacion-api` ([api/](api/))

Servicio REST multi-tenant que envuelve al motor y lo ofrece como SaaS.
**Este es el producto**. Acepta que clientes suban su certificado digital,
emiten documentos electrónicos vía HTTP, y todo queda persistido con
audit trail.

- Código: [api/src/](api/src/)
- Tests: [api/test/](api/test/) — 42 tests pasando
- README del API: [api/README.md](api/README.md)
- Guía de deploy: [api/DEPLOY.md](api/DEPLOY.md)

**Todo este documento se refiere a `facturacion-api` salvo que diga lo contrario.**

---

## Arquitectura

### Modelo de multi-tenancy (2 niveles)

```
Company A ── "POS Retail SaaS" ── cmp_key_abc... (API key master)
├── Tenant A1 (RUC 80012345-1, "Panadería Elsa")
│   ├── cert_A1.p12 (cifrado en DB)
│   ├── CSC del portal ekuatia
│   ├── Documento #001 → CDC 01800...
│   └── Documento #002 → CDC 01800...
└── Tenant A2 (RUC 80099999-3, "Ferretería Central")
    └── ...

Company B ── "Restaurantes Manager" ── cmp_key_xyz...
└── Tenant B1 (RUC 80055555-7, "Parrilla Fuego")
    └── ...
```

**Reglas de aislamiento** (las enforza [tenant-scope middleware](api/src/middleware/tenant-scope.ts)):

- Company A **jamás** ve tenants, documentos, certs o errores de Company B
- Todas las queries filtran primero por `company_id`
- Acceso cross-company devuelve **404 (no 403)** para no revelar existencia
- Billing es **por company** (un solo bill consolidado por todos sus tenants)
- Numeración de facturas es **por tenant** (cada RUC tiene su propia secuencia)

### Stack técnico

| Capa | Tecnología | Ver también |
|---|---|---|
| Runtime | Node 20 LTS + TypeScript 5 | |
| HTTP framework | **Fastify 5** + `fastify-type-provider-zod` | [app.ts](api/src/app.ts) |
| Schema validation | **zod** | |
| ORM | **Drizzle** + postgres-js | [db/schema.ts](api/src/db/schema.ts) |
| Base de datos | **Postgres 16** | |
| Cola de jobs | **BullMQ + Redis 7** | [queue/](api/src/queue/) |
| Storage | **MinIO** (dev) / DO Spaces (prod) — S3-compatible | [storage/s3.ts](api/src/storage/s3.ts) |
| XSD validator | `xmllint` (libxml2 CLI) | [lib/xsd-validator.ts](api/src/lib/xsd-validator.ts) |
| Observabilidad | pino + Sentry + OpenAPI/Swagger | [lib/sentry.ts](api/src/lib/sentry.ts) |
| Contenedores | Docker multi-stage + Coolify | [Dockerfile](api/Dockerfile) + [DEPLOY.md](api/DEPLOY.md) |
| Tests | **Vitest** | |

### Diagrama end-to-end

```
          ┌─────────────────────────────────┐
          │  POS del cliente de Company A   │
          │  POST /v1/tenants/X/de          │
          │  Authorization: Bearer cmp_...  │
          │  Idempotency-Key: uuid-...      │
          └────────────────┬────────────────┘
                           │ HTTPS
                           ▼
          ┌────────────────────────────────────────┐
          │  Fastify API (Docker, Coolify, DO)     │
          │                                         │
          │  preHandlers:                           │
          │    requireAuth → company_id             │
          │    requireTenantScope → tenant          │
          │    idempotencyCheck (Redis/DB)          │
          │                                         │
          │  handler (de.service.createDeDocument): │
          │    BEGIN TRANSACTION                    │
          │      SELECT FOR UPDATE numeracion       │
          │      INSERT documents (estado=generando)│
          │    COMMIT                               │
          │    xmlgen.generateXMLDE(params, data)   │
          │    validatePreSigning (xmllint)         │
          │    ┌─── if ENABLE_SIFEN=true ──┐        │
          │    │  decryptCertBundle        │        │
          │    │  xmlsign.signXML          │        │
          │    │  validatePostSigning      │        │
          │    │  qrgen.generateQR         │        │
          │    │  setapi.recibe → SIFEN    │        │
          │    │  parse response           │        │
          │    └───────────────────────────┘        │
          │    upload XML a S3                      │
          │    UPDATE documents (cdc, estado, ...)  │
          │                                         │
          │  onSend: idempotencyPersist             │
          │  onResponse: auditLog                   │
          └─┬────────────┬───────────┬──────────┬───┘
            │            │           │          │
            ▼            ▼           ▼          ▼
      ┌──────────┐ ┌────────┐ ┌────────┐ ┌─────────┐
      │ Postgres │ │ Redis  │ │ MinIO/ │ │ SIFEN   │
      │ managed  │ │ BullMQ │ │ Spaces │ │ SOAP    │
      │ 9 tablas │ │ queues │ │ xml/   │ │test/prod│
      │ + RLS    │ │ + GC   │ │ kude/  │ │         │
      └──────────┘ └────┬───┘ └────────┘ └─────────┘
                        │
                        ▼
                  ┌───────────┐
                  │  Worker   │
                  │  (Docker) │
                  │ sifen-    │
                  │ batch +   │
                  │ retry     │
                  └───────────┘
```

### Esquema de base de datos

9 tablas definidas en [api/src/db/schema.ts](api/src/db/schema.ts):

| Tabla | Qué guarda | Clave por |
|---|---|---|
| `companies` | Plataformas clientes del servicio | `id` (uuid) |
| `tenants` | Contribuyentes emisores (RUCs) | `id`, `company_id` |
| `tenant_certs` | Certificados `.p12` cifrados con envelope encryption | `tenant_id` (1:1) |
| `tenant_csc` | CSC cifrado por tenant | `tenant_id` (1:1) |
| `documents` | Facturas/NC emitidas, con XML en S3 | `id`, `cdc`, `(tenant_id, tipo, est, punto, numero)` |
| `numeracion` | Secuencia por tenant+tipo+est+punto (SELECT FOR UPDATE) | `(tenant_id, tipo, est, punto)` |
| `eventos` | Cancelaciones y otros eventos SIFEN | `id` |
| `idempotency_keys` | Cache de responses 2xx con TTL 24h | `(company_id, key)` |
| `api_logs` | Audit trail de requests (sin payloads sensibles) | `id` |

---

## Estado actual del código

### ✅ Fase 2 MVP — 100% implementado

| Área | Detalle | Commit |
|---|---|---|
| Scaffolding + DB + envelope crypto | Fastify, Drizzle, tests de crypto | `c597536` |
| Tenants CRUD + cert upload | Multipart .p12 + node-forge | `0ab81d4` |
| Emisión síncrona de DE | Pipeline completo, idempotencia, numeración | `c824aaf` |
| CSC + download XML + consulta SIFEN | Endpoints de post-emisión | `1aaf8f2` |
| Cancelación de documentos | Evento SIFEN único del MVP | `05ce8fb` |
| Deploy infra (Docker + CI + Coolify) | Multi-stage, GitHub Actions, DEPLOY.md | `10a90c1` |
| Queue async con BullMQ | Batch submission, workers, retry | `0dc04f1` |
| Hardening pre-producción | Sentry, Swagger, rate limit, audit, GC | `9d7002a` |
| **fix crítico: cert bundle DEK** | **Una sola DEK compartida p12 + password** | **`fafe319`** |

### 📊 Métricas del proyecto

```
lenguaje:         TypeScript (ESM, strict)
líneas de código: ~4.500 LOC en api/src/
endpoints:        26 bajo /v1
tablas DB:        9
tests unitarios:  42/42 pasando
dependencias:     ~400 paquetes npm
imagen Docker:    ~250 MB (Alpine)
```

### 🧪 Tests existentes (42/42)

Ver [api/test/](api/test/):

- **crypto/envelope.test.ts (12)** — AES-256-GCM round trip, tampering en 4 puntos, KEK rotation
- **services/cert.service.test.ts (17)** — parseP12, validación vigencia/RUC, envelope, **regression test del round-trip DB** (el que hubiera atrapado el bug de la DEK)
- **lib/cdc.test.ts (8)** — extract CDC, format validation, random seguro
- **services/csc.service.test.ts (5)** — envelope del CSC

### ❌ Tests que faltan

- **Tests de integración contra Postgres real** (Fastify `.inject()` + DB de test)
- **Tests de concurrency de numeración** (simular 10 emisiones simultáneas del mismo tenant)
- **Tests del workflow de batch** con Redis real + worker
- **Tests end-to-end contra SIFEN test environment** (requiere cert)

---

## Qué está probado y qué no

**⚠️ Esto es lo más importante de leer antes de asumir que el API funciona.**

### ✅ Sí probado

- Unit tests de módulos puros (crypto, cdc, cert parsing en memoria)
- `npm run typecheck` — 0 errores
- `npm run build` — dist/ generado OK
- `node dist/server.js` arranca y responde en `/v1/health`, `/`
- Rutas responden códigos correctos ante requests sin auth (401)
- OpenAPI spec se genera correctamente con 26 endpoints en `/docs/json`
- Swagger UI renderiza en `/docs`
- Rate limit headers `x-ratelimit-*` aparecen en responses

### ❌ NO probado (blockers honestos)

Esto es lo que **nunca corrió contra infraestructura real**:

| Qué | Por qué no se probó |
|---|---|
| Migrations aplicadas a un Postgres real | No hay Docker instalado en la máquina de dev |
| El pipeline completo `POST /de` creando un document row | Requiere DB |
| `SELECT FOR UPDATE` en numeración | Requiere DB + concurrencia |
| Upload multipart del `.p12` con schema zod simultáneo | Requiere cliente HTTP real (curl con archivo) |
| BullMQ worker procesando un job real | Requiere Redis + DB |
| S3 upload/download del XML | Requiere MinIO |
| Audit log insert en `api_logs` | Requiere DB |
| Rate limit keyed por `company_id` (probablemente mal — ver sección de bugs) | Requiere auth real |
| El Dockerfile ejecutado de punta a punta | Requiere `docker build` |
| GitHub Actions workflow corriendo en CI | Nunca hubo PR |
| Envío real a SIFEN test | **Requiere cert `.p12`** |

### 🐛 Bugs encontrados por audit manual

1. **Cert bundle con 2 DEKs distintas, solo 1 persistida**
   — ✅ arreglado en `fafe319` con regression test. Los unit tests originales no lo atraparon porque testeaban encrypt/decrypt con el bundle vivo en memoria, nunca el round-trip DB.

Probablemente haya más bugs del mismo tipo escondidos. La sección [Bugs sospechosos](#bugs-sospechosos-pendientes-de-verificar) los lista.

---

## Cómo correrlo localmente

### Prerequisitos

- **Node 20+**
- **Docker Desktop** (crítico — todo lo importante necesita Postgres + Redis + MinIO)
- `libxml2-utils` para `xmllint` (viene instalado en macOS y en el Dockerfile)

### Opción A — Solo el API, deps en Docker

Más rápido para iterar sobre código TypeScript en vivo.

```bash
# Desde la raíz del repo
cd api

# Copiar env de ejemplo
cp .env.example .env

# Generar MASTER_KEY_BASE64 (32 bytes en base64)
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
sed -i '' "s|MASTER_KEY_BASE64=.*|MASTER_KEY_BASE64=$KEY|" .env

# Levantar solo deps (postgres, redis, minio)
docker compose up -d postgres redis minio minio-init

# Instalar y compilar
npm install
npm run db:generate  # genera migrations SQL desde schema.ts
npm run db:migrate   # aplica migrations
npm run dev          # tsx watch mode
```

En otra terminal:

```bash
# Probar signup
curl -X POST http://localhost:3000/v1/companies \
  -H 'content-type: application/json' \
  -d '{"name":"Acme POS","email":"admin@acme.com"}'
```

### Opción B — Todo en Docker

Más cercano a producción. Útil para validar que el Dockerfile funciona.

```bash
# Desde la raíz del repo (importante: root, no api/)
export MASTER_KEY_BASE64="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
docker compose -f api/docker-compose.yml up --build
```

### Opción C — Con workers activos

Para probar el flow async de batch.

```bash
export MASTER_KEY_BASE64="..."
docker compose -f api/docker-compose.yml --profile workers up --build
```

---

## Endpoints del API

**Documentación interactiva:** http://localhost:3000/docs (Swagger UI)
**OpenAPI JSON:** http://localhost:3000/docs/json

### Públicos (sin auth)

```
POST   /v1/companies                              signup, retorna API key
GET    /v1/health                                 liveness probe
GET    /v1/health/ready                           readiness (chequea DB)
```

### Company (auth)

```
GET    /v1/companies/me                           perfil
```

### Tenants

```
POST   /v1/tenants                                crear
GET    /v1/tenants                                listar paginado
GET    /v1/tenants/:tenant_id                     detalle
PATCH  /v1/tenants/:tenant_id                     actualizar
DELETE /v1/tenants/:tenant_id                     suspender
```

### Certificados (.p12 + CSC)

```
POST   /v1/tenants/:tenant_id/cert                upload multipart (.p12 + password)
GET    /v1/tenants/:tenant_id/cert                metadata (fingerprint, expiración)
DELETE /v1/tenants/:tenant_id/cert                revocar

PUT    /v1/tenants/:tenant_id/csc                 set/rotate CSC
GET    /v1/tenants/:tenant_id/csc                 metadata
DELETE /v1/tenants/:tenant_id/csc                 eliminar
```

### Documentos electrónicos

```
POST   /v1/tenants/:tenant_id/de                  emitir (Factura o NC)
       headers: Idempotency-Key <string>          (recomendado)
GET    /v1/tenants/:tenant_id/de                  listar paginado
GET    /v1/tenants/:tenant_id/de/:cdc             detalle + presigned URL
GET    /v1/tenants/:tenant_id/de/:cdc/xml         download directo del XML
POST   /v1/tenants/:tenant_id/de/:cdc/consulta    re-consultar SIFEN
```

### Emisión por lotes (async)

```
POST   /v1/tenants/:tenant_id/de/batch            hasta 500 docs
GET    /v1/tenants/:tenant_id/de/batch/:batch_id  estado agregado
```

### Eventos SIFEN

```
POST   /v1/tenants/:tenant_id/eventos/cancelacion cancelar un DE emitido
GET    /v1/tenants/:tenant_id/eventos             listar eventos
```

### Consultas read-only SIFEN

```
GET    /v1/tenants/:tenant_id/consulta/ruc/:ruc   información de un RUC
```

---

## Flujo completo para un cliente integrador

Este es el flow que va a seguir un POS al integrarse con el API.
Cuando Docker esté arriba, se puede ejecutar paso a paso con curl.

### 1. Signup de la company (plataforma)

```bash
curl -X POST http://localhost:3000/v1/companies \
  -H 'content-type: application/json' \
  -d '{"name":"Acme POS","email":"admin@acme.com"}'
```

Respuesta:
```json
{
  "id": "uuid-...",
  "apiKey": "cmp_a1b2c3d4e5f6...",
  "apiKeyPrefix": "cmp_a1b2c3"
}
```

**Guardar `apiKey` inmediatamente** — solo se muestra una vez.

### 2. Crear un tenant (contribuyente emisor)

```bash
API_KEY=cmp_a1b2c3d4e5f6...

curl -X POST http://localhost:3000/v1/tenants \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "ruc": "80069563-1",
    "razonSocial": "Panadería Elsa S.A.",
    "nombreFantasia": "Panadería Elsa",
    "timbradoNumero": "12558946",
    "timbradoFecha": "2024-01-01",
    "tipoContribuyente": 2,
    "tipoRegimen": 8,
    "establecimientos": [{
      "codigo": "001",
      "direccion": "Barrio Central",
      "numeroCasa": "0",
      "departamento": 1,
      "departamentoDescripcion": "CAPITAL",
      "distrito": 1,
      "distritoDescripcion": "ASUNCION",
      "ciudad": 1,
      "ciudadDescripcion": "ASUNCION",
      "telefono": "021555555",
      "email": "contacto@elsa.com.py",
      "denominacion": "Casa Central"
    }],
    "actividadesEconomicas": [
      {"codigo": "1071", "descripcion": "Elaboración de productos de panadería"}
    ],
    "env": "test"
  }'
```

Guardar el `id` devuelto como `TENANT_ID`.

### 3. Subir el certificado `.p12`

```bash
curl -X POST http://localhost:3000/v1/tenants/$TENANT_ID/cert \
  -H "authorization: Bearer $API_KEY" \
  -F "file=@/ruta/al/Certificado.p12" \
  -F "password=tu_password_del_cert"
```

Respuesta:
```json
{
  "fingerprint": "abc123...",
  "subjectCn": "PANADERIA ELSA 80069563",
  "subjectRuc": "80069563",
  "notBefore": "2024-01-01T00:00:00Z",
  "notAfter": "2025-12-31T23:59:59Z",
  "daysUntilExpiration": 456
}
```

### 4. Configurar el CSC

```bash
curl -X PUT http://localhost:3000/v1/tenants/$TENANT_ID/csc \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"cscId":"1","csc":"ABCD1234EFGH5678IJKL9012MNOP3456"}'
```

### 5. Emitir una Factura

```bash
curl -X POST http://localhost:3000/v1/tenants/$TENANT_ID/de \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" \
  -d '{
    "tipoDocumento": 1,
    "establecimiento": "001",
    "punto": "001",
    "tipoTransaccion": 1,
    "moneda": "PYG",
    "descripcion": "Factura de prueba",
    "cliente": {
      "contribuyente": true,
      "ruc": "2005001-1",
      "razonSocial": "Cliente Test",
      "direccion": "Test 123",
      "tipoOperacion": 1,
      "pais": "PRY",
      "paisDescripcion": "Paraguay",
      "telefono": "021555555",
      "email": "cliente@test.com"
    },
    "factura": {"presencia": 1},
    "condicion": {
      "tipo": 1,
      "entregas": [{"tipo": 1, "monto": "100000", "moneda": "PYG", "cambio": 0}]
    },
    "items": [{
      "codigo": "A-001",
      "descripcion": "Producto de prueba",
      "unidadMedida": 77,
      "cantidad": 2,
      "precioUnitario": 50000,
      "ivaTipo": 1,
      "ivaBase": 100,
      "iva": 10
    }]
  }'
```

Respuesta (con `ENABLE_SIFEN=true`):
```json
{
  "txnId": "uuid-...",
  "cdc": "01800695631001001000000122025011510002983981",
  "estado": "aprobado",
  "numero": "0000001",
  "xmlUrl": "http://minio:9000/...",
  "signed": true,
  "sentToSifen": true,
  "sifen": {"codigoRespuesta": "0260", "mensaje": "..."}
}
```

### 6. Consultar el detalle

```bash
curl http://localhost:3000/v1/tenants/$TENANT_ID/de/01800695631001001000000122025011510002983981 \
  -H "authorization: Bearer $API_KEY"
```

### 7. Descargar el XML firmado

```bash
curl -O http://localhost:3000/v1/tenants/$TENANT_ID/de/01800695631001001000000122025011510002983981/xml \
  -H "authorization: Bearer $API_KEY"
```

### 8. Cancelar (si hace falta)

```bash
curl -X POST http://localhost:3000/v1/tenants/$TENANT_ID/eventos/cancelacion \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "cdc": "01800695631001001000000122025011510002983981",
    "motivo": "Error en el monto del documento original"
  }'
```

---

## Variables de entorno

Ver [api/.env.example](api/.env.example) para el archivo completo con comentarios.

### Críticas

| Variable | Descripción |
|---|---|
| `MASTER_KEY_BASE64` | KEK master de 32 bytes. **Si se pierde, todos los certs quedan inaccesibles.** Backup offline obligatorio. |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `S3_*` | Endpoint, bucket, credentials de MinIO o DO Spaces |
| `ENABLE_SIFEN` | `false` = skip firma+envío (testing local sin cert). `true` = pipeline completo |

### Operacionales

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | 3000 | Puerto HTTP del API |
| `LOG_LEVEL` | `info` | pino: trace/debug/info/warn/error/fatal |
| `CORS_ORIGINS` | `*` | Lista CSV o `*` |
| `RATE_LIMIT_MAX` | 600 | Requests permitidas en la ventana |
| `RATE_LIMIT_WINDOW_MS` | 60000 | Ventana del rate limit en ms |
| `IDEMPOTENCY_GC_INTERVAL_MS` | 3600000 | Cada cuánto corre el GC de keys expirados |
| `ENABLE_API_DOCS` | `true` | Expone `/docs` con Swagger UI |
| `SENTRY_DSN` | (vacío) | Si se setea, inicializa Sentry |
| `SENTRY_ENVIRONMENT` | `development` | Tag en Sentry |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | 10% de traces |

---

## Lo que falta para producción (checklist)

### 🔴 Blockers reales (sin esto no se deploya)

- [ ] **Certificado `.p12` de prueba SIFEN** del portal ekuatia.set.gov.py
- [ ] **CSC** del mismo portal (Perfil → Ambiente de prueba → CSC)
- [ ] **Docker local funcionando** para probar el flow completo antes de deployar
- [ ] **Probar todo el flow** localmente con cert sintético (node-forge) **primero**,
  luego con el cert real en ambiente test SIFEN
- [ ] **Calibrar códigos de respuesta SIFEN** reales — los `0260/1001/1002` en
  [de.service.ts](api/src/services/de.service.ts#L301) y
  [evento.service.ts](api/src/services/evento.service.ts#L207) son guesses
- [ ] **Droplet en DigitalOcean** con Coolify instalado
- [ ] **Postgres managed** en DO (recomendado) o contenedor en Coolify
- [ ] **Redis** en Coolify
- [ ] **MinIO o Spaces** para storage
- [ ] **`MASTER_KEY_BASE64` generada** + **backup offline triple** (password manager +
  caja fuerte física + archivo cifrado en otro storage)
- [ ] **Dominio** apuntado al droplet con DNS
- [ ] **Primer deploy de prueba** en staging antes de prod

### 🟡 Mejoras recomendadas antes del primer cliente real

- [ ] **Tests de integración** contra Postgres + Redis reales (CI con docker compose)
- [ ] **Alerta automática** de certs por vencer (cron diario)
- [ ] **KUDE (PDF)** con `facturacionelectronicapy-kude`
- [ ] **Procedimiento de rotación de API keys** (endpoint ya en el plan, sin implementar)
- [ ] **Postman collection** para entregar a los devs de los clientes
- [ ] **Dev portal con docs** (Docusaurus o similar)
- [ ] **Sentry DSN configurado** + alerting de errores 5xx

### 🟢 Nice-to-have post-lanzamiento

- [ ] Otros eventos SIFEN (inutilización, conformidad, etc.)
- [ ] Otros tipos de documento (Autofactura, Remisión, Nota Débito)
- [ ] Webhooks por company
- [ ] Panel admin web (Next.js)
- [ ] Métricas Prometheus + Grafana
- [ ] OpenTelemetry tracing
- [ ] Billing + quotas + sistema de cobro

### 🔵 Negocio (no código)

- [ ] Modelo de pricing
- [ ] Landing page + signup público
- [ ] Términos de servicio + privacy policy (ley 6534/2020 PY)
- [ ] SLA definido
- [ ] Canal de soporte (email/Discord/Intercom)
- [ ] Contratos con los primeros clientes

---

## Plan de pruebas antes del primer cliente

**Esta sección es la más importante del documento.** El código está 100%
implementado pero **nunca se ejecutó contra infra real**. Antes de aceptar
clientes de verdad, hay que pasar por este checklist.

### Fase 0 — Setup local con Docker (1-2 horas)

1. **Instalar Docker Desktop en Mac**
2. **Levantar el stack completo:**
   ```bash
   cd /Users/xstian/Dropbox/Factura\ Electrónica/FE-PY
   export MASTER_KEY_BASE64="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
   docker compose -f api/docker-compose.yml up --build
   ```
3. **Esperar a que todos los servicios estén healthy**
4. **Probar health:**
   ```bash
   curl http://localhost:3000/v1/health/ready
   # → {"status":"ok","checks":{"database":"ok"}}
   ```
5. **Abrir Swagger:** http://localhost:3000/docs

**Qué puede fallar:**
- Dockerfile con COPY incorrecto del motor parent
- Migrations fallando por falta de `pgcrypto` extension
- Bucket de MinIO no creado por `minio-init`

### Fase 1 — Flow completo sin cert real (2-3 horas)

Con `ENABLE_SIFEN=false`, ejecutar **el flow 1-8 del cliente integrador**
con un cert sintético generado por node-forge (el mismo patrón que usan los
tests unitarios).

Crear un script `api/scripts/e2e-test.sh`:

```bash
#!/bin/bash
set -e
# 1. Signup
RESP=$(curl -s -X POST http://localhost:3000/v1/companies \
  -H 'content-type: application/json' \
  -d '{"name":"Test Co","email":"test@test.com"}')
API_KEY=$(echo $RESP | jq -r .apiKey)
echo "API_KEY=$API_KEY"

# 2. Crear tenant
RESP=$(curl -s -X POST http://localhost:3000/v1/tenants \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d @tenant-fixture.json)
TENANT_ID=$(echo $RESP | jq -r .id)
echo "TENANT_ID=$TENANT_ID"

# 3. Generar p12 sintético con node-forge (ver cert.service.test.ts)
node generate-test-p12.js 80069563-1 'test-pwd' > /tmp/test.p12

# 4. Upload cert
curl -X POST http://localhost:3000/v1/tenants/$TENANT_ID/cert \
  -H "authorization: Bearer $API_KEY" \
  -F "file=@/tmp/test.p12" \
  -F "password=test-pwd"

# 5. Set CSC
curl -X PUT http://localhost:3000/v1/tenants/$TENANT_ID/csc \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"cscId":"1","csc":"ABCD1234EFGH5678IJKL9012MNOP3456"}'

# 6. Emitir DE (ENABLE_SIFEN=false: skip firma, solo genera XML)
curl -X POST http://localhost:3000/v1/tenants/$TENANT_ID/de \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" \
  -d @factura-fixture.json
```

**Qué hay que validar en esta fase:**
- [ ] Signup devuelve API key válida
- [ ] Crear tenant persiste en DB con el company_id correcto
- [ ] Upload multipart del p12 parsea + cifra + guarda
- [ ] GET cert metadata devuelve fingerprint correcto
- [ ] CSC se guarda cifrado
- [ ] POST /de genera XML válido contra XSD pre-firma
- [ ] Numeración se incrementa correctamente
- [ ] XML se sube a MinIO
- [ ] GET /de/:cdc devuelve el detalle con presigned URL
- [ ] Download del XML funciona
- [ ] El document row aparece en `api_logs` (audit trail)
- [ ] Idempotency key rechaza segundo intento con body distinto

**Bugs esperables en esta fase** (basados en el [análisis de sospechosos](#bugs-sospechosos-pendientes-de-verificar)):
- Conflicto entre `@fastify/multipart` y schema zod del body
- Rate limit keyed por IP siempre (no por company)
- Error en `SELECT FOR UPDATE` con Drizzle
- Problemas de `reply.elapsedTime` en audit log
- Serialización zod de `.nullable()` campos

### Fase 2 — Flow con cert real en SIFEN test (1-3 horas)

1. **Conseguir el `.p12` real** del portal ekuatia
2. **Flip `ENABLE_SIFEN=true` en `.env`**
3. **Rebuild del contenedor** (`docker compose up --build`)
4. **Repetir el flow E2E con el cert real**
5. **Inspeccionar la respuesta SIFEN** — guardar en un archivo para análisis
6. **Calibrar los códigos SIFEN** en `de.service.ts` y `evento.service.ts`
   basándose en la respuesta real
7. **Probar cancelación** del documento emitido
8. **Probar consulta RUC** con `GET /v1/tenants/:id/consulta/ruc/:ruc`

**Qué hay que validar:**
- [ ] El `xmlsign.signXML` no falla con el cert real (diferente de sintético)
- [ ] SIFEN responde con código de éxito (calibrar qué códigos son "aprobado")
- [ ] El QR se genera correctamente con `qrgen`
- [ ] La cancelación se acepta en SIFEN
- [ ] `setapi.consulta` devuelve el estado correcto para un CDC existente

### Fase 3 — Deploy a Coolify staging (2-4 horas)

1. Crear droplet en DO con Coolify
2. Configurar servicios: Postgres managed + Redis + MinIO
3. Crear app en Coolify apuntando al repo
4. Configurar env vars (ver [DEPLOY.md](api/DEPLOY.md))
5. **Backup offline de MASTER_KEY_BASE64** antes del primer deploy
6. Primer deploy
7. Repetir E2E test contra el endpoint staging
8. Verificar logs, Sentry, métricas

---

## Bugs sospechosos pendientes de verificar

Código que leí y marca amarilla pero no pude probar sin infra real:

| # | Archivo:línea | Sospecha | Prioridad |
|---|---|---|---|
| 1 | [app.ts:86](api/src/app.ts#L86) | `rateLimit keyGenerator` se ejecuta ANTES del auth preHandler → `req.company` siempre undefined → rate limit siempre por IP, nunca por company_id | Alta |
| 2 | [tenant-certs.ts:51](api/src/routes/tenant-certs.ts#L51) | Ruta multipart con schema zod del body vacío — Fastify puede rechazar antes de llegar al handler | **Crítica** |
| 3 | [numeracion.service.ts:50](api/src/services/numeracion.service.ts#L50) | `tx.execute(sql\`...FOR UPDATE\`)` cast a `Array<{...}>` puede no coincidir con postgres-js row shape | Alta |
| 4 | [audit-log.ts:32](api/src/middleware/audit-log.ts#L32) | `reply.elapsedTime` puede no existir en Fastify 5 (podría ser `getResponseTime()`) | Media |
| 5 | [de.service.ts:179](api/src/services/de.service.ts#L179) | Body del cliente pasa al motor `xmlgen` sin validar que tiene los campos que espera — errores 500 en primeros intentos | Alta |
| 6 | [schema.ts:X](api/src/db/schema.ts) | `uuid().defaultRandom()` requiere extensión `pgcrypto` habilitada en Postgres — puede fallar en migrations | Alta |
| 7 | varios `.nullable()` en response schemas | Zod puede rechazar null en runtime si los tipos de Drizzle llegan como `undefined` | Media |
| 8 | [app.ts:168](api/src/app.ts#L168) | onError hook envía a Sentry con filtro `statusCode < 500`, pero AppError no setea `statusCode` del modo que Fastify espera — puede estar mandando 4xx a Sentry (spam) | Baja |
| 9 | [xsd-validator.ts:20](api/src/lib/xsd-validator.ts#L20) | `process.env.XSD_UNSIGNED_PATH` se lee al top-level — puede cachear valores de test si algún test importa este módulo indirectamente | Baja |
| 10 | Varios routes: `reply.status(204).send(null)` | Fastify + zod con response schema `z.null()` puede no coincidir con `null` literal — probar delete endpoints | Media |

**Todos se resuelven con Fase 1 del plan de pruebas** — arrancar, probar, ver qué rompe, arreglar, iterar.

---

## Roadmap post-MVP

Una vez que Fase 1-3 estén OK y tengas **1 cliente real emitiendo facturas**:

### Sprint 1 — Producto completo (2 semanas)

- KUDE (PDF) con `facturacionelectronicapy-kude`
- Notas de Débito, Autofactura, Remisión (tipos de documento restantes)
- Eventos restantes: inutilización, conformidad, disconformidad, desconocimiento, notificación, nominación, actualización transporte
- Alerta automática de certs por expirar (cron + email)
- Rotación de API keys

### Sprint 2 — Escala (2-3 semanas)

- Webhooks por company (firmados con HMAC)
- Panel admin web (Next.js) — dashboard, certs por vencer, logs, métricas
- Tests de integración en CI con Docker
- Dev portal con docs públicas (Docusaurus)
- Postman collection + code samples

### Sprint 3 — Operación (2 semanas)

- Métricas Prometheus + Grafana dashboards
- OpenTelemetry tracing con tenant_id/company_id
- Backups automáticos de Postgres + restore probado
- Rotación semestral de KEK (script + procedimiento)
- Bull Board para inspeccionar jobs
- Rate limiting más sofisticado (por endpoint, por tier de company)

### Sprint 4 — Comercialización (paralelo al resto)

- Sistema de billing (Stripe o local)
- Quotas por tier
- Landing page + signup público
- Legal: TOS, Privacy Policy (ley 6534/2020 PY)
- SLA + página de status

---

## Referencias a otros documentos

| Documento | Qué contiene |
|---|---|
| [README.md](README.md) | Motor xmlgen original (upstream, Marcos Jara) |
| [PLAN.md](PLAN.md) | Plan detallado de fases con schema DB, endpoints, arquitectura |
| [api/README.md](api/README.md) | Quickstart y scripts del API |
| [api/DEPLOY.md](api/DEPLOY.md) | Guía completa de deploy a Coolify + DO |
| [api/.env.example](api/.env.example) | Todas las env vars con comentarios |
| [api/src/db/schema.ts](api/src/db/schema.ts) | Schema DB completo (9 tablas) |
| [api/src/app.ts](api/src/app.ts) | Entry point Fastify con todos los plugins |
| [test-ui.js](test-ui.js) | Formulario de prueba local del motor (standalone, sin API) |

---

## Resumen en 5 líneas

1. **Todo el código del MVP comercial está hecho**, 42 tests pasando, 26 endpoints documentados.
2. **Nada corrió contra infraestructura real todavía** — postgres, redis, minio, SIFEN.
3. **Encontré 1 bug crítico releyendo** (DEK del cert) y hay **~10 sospechosos más** que solo se detectan con Docker arriba.
4. **Lo siguiente NO es conseguir el cert** — es **instalar Docker, levantar el stack, y correr el flow E2E con cert sintético** para shakear los bugs escondidos.
5. **Después** de eso sí: cert real → ambiente SIFEN test → calibrar códigos → deploy staging → primer cliente beta.
