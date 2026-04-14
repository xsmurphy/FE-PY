# Plan: Motor de Facturación Electrónica Paraguay - API Multi-tenant

> **⚠️ DOCUMENTO HISTÓRICO — plan inicial del proyecto (2026-04-13).**
>
> Este archivo es la hoja de ruta original escrita antes de empezar a codear,
> y describe las 3 fases del proyecto en detalle. **La Fase 2 está completa**
> (validada end-to-end en Docker con Postgres + Redis + MinIO reales) y la
> Fase 3 arrancó parcialmente.
>
> **Para el estado actual del proyecto, leé [NEXT_STEPS.md](NEXT_STEPS.md)** —
> ese es el documento que se mantiene actualizado con cada commit.
>
> **Para quickstart del API**, leé [api/README.md](api/README.md).
>
> **Para deploy a producción**, leé [api/DEPLOY.md](api/DEPLOY.md).
>
> Este documento se mantiene como referencia histórica del plan y las
> decisiones de diseño. No documenta el estado real del código.

---

## Contexto

Servicio comercial SaaS que expone el motor de facturación electrónica SIFEN Paraguay
como API REST. Las "Companies" son plataformas (ej. un SaaS de POS) que integran este
servicio para ofrecer facturación electrónica a sus propios clientes (los "Tenants",
que son los contribuyentes emisores con su propio RUC y certificado).

**Ya existen clientes esperando.** Urgencia real.

---

## Estado actual (snapshot del 13 abr — pre-implementación)

Este repo contiene el **motor** — generación + validación + firma + envío. Ya está
armado al 100% hasta el paso de firma. Lo único que bloquea validar end-to-end es
conseguir un certificado `.p12` de prueba.

| Componente | Estado al 13/abr |
|---|---|
| `xmlgen` (generación XML v150) | ✓ |
| Validación XSD pre/post firma (xmllint + xsd/ + xsd-unsigned/) | ✓ |
| `xmlsign` (firma XMLDSig) | ✓ instalado, no probado con cert real |
| `qrgen` (generación QR) | ✓ instalado, no probado |
| `setapi` (envío SOAP SIFEN) | ✓ instalado, no probado |
| `test-ui.js` pipeline completo | ✓ funcional hasta "Firmar" |
| Cert `.p12` + CSC | ✗ **bloqueante** |

**Actualización 14/abr:** todo el plan de Fase 2 de abajo se ejecutó en ~10 batches
de desarrollo, más 1 batch de bug fixes tras la primera corrida E2E en Docker.
Ver [NEXT_STEPS.md](NEXT_STEPS.md#historial-de-batches) para el historial completo.

---

## Arquitectura decidida

### Modelo de multi-tenancy: 2 niveles

```
Company A (plataforma "POS Retail SaaS") ──── cmp_key_abc123 (master API key)
├── Tenant A1 (RUC 8000001-1, "Panadería Elsa") ── cert_A1.p12
│   ├── DE #001  (txn: 01HXY...)
│   └── DE #002
├── Tenant A2 (RUC 8000002-5, "Ferretería Central") ── cert_A2.p12
│   └── DE #001
└── tenants totalmente aislados de Company B

Company B (plataforma "Restaurantes Manager") ──── cmp_key_def456
├── Tenant B1 (RUC 8000003-2) ── cert_B1.p12
└── ...
```

**Reglas duras de aislamiento:**
- Company A **jamás** ve tenants, documentos, certs o errores de Company B.
- Todas las queries filtran por `company_id` (derivado del API key) antes de cualquier otro WHERE.
- Row-level security opcional en Postgres como defensa en profundidad.
- Billing es por company (un solo bill consolidado por todos sus tenants).
- Numeración de facturas es **por tenant** (cada RUC tiene su propia secuencia en SIFEN).

### Stack

| Capa | Tecnología | Razón |
|---|---|---|
| Runtime | Node 20 LTS + TypeScript | Consistente con `facturacionelectronicapy-*` |
| Framework HTTP | **Fastify** | Más rápido que Express, schema validation AJV built-in |
| DB | **Postgres 16** | Transacciones, row-level security, JSON nativo |
| ORM | **Drizzle** | Liviano, SQL-first, migrations code-based |
| Cola de jobs | **Redis 7 + BullMQ** | Lotes async, reintentos SIFEN, dead-letter queue |
| Object storage | **MinIO** (S3-compatible, dev/staging) → DO Spaces (prod futuro) | Migración = cambio de env vars |
| XSD validator | `xmllint` (libxml2, en el contenedor) | Ya probado, más confiable que bindings Node |
| Logs | `pino` (JSON estructurados) | Sin payloads sensibles |
| Errores | Sentry | Alertas + tracking por tenant |
| Contenedor | Docker multi-stage (Alpine + libxml2-utils) | Imagen final <200 MB |
| Deploy | **Coolify en DigitalOcean** | Decidido |
| CI | GitHub Actions | Build + tests + push a registry |

### Diagrama

```
                            ┌────────────────────────────────┐
                            │  Fastify API (Node + TS)       │
                            │  Auth: Bearer cmp_key_*        │
                            │  ┌───────────────────────────┐ │
   POS de Cliente ──HTTPS──▶│  │ /v1/tenants/*             │ │
   de Company A             │  │ /v1/tenants/:id/de        │ │
                            │  │ /v1/tenants/:id/eventos/* │ │
                            │  │ /v1/tenants/:id/de/:cdc   │ │
                            │  └───────────────────────────┘ │
                            └──┬────────────┬────────────┬───┘
                               │            │            │
                               ▼            ▼            ▼
                         ┌─────────┐  ┌──────────┐  ┌──────────┐
                         │Postgres │  │  Redis   │  │  MinIO   │
                         │         │  │  BullMQ  │  │          │
                         │companies│  │          │  │ xml/     │
                         │tenants  │  │  queues: │  │ kude/    │
                         │certs🔒 │  │  - send  │  │          │
                         │documents│  │  - batch │  └──────────┘
                         │numera   │  │  - query │
                         │eventos  │  └──────────┘       │
                         │idempoten│                      │
                         │api_logs │                      ▼
                         └─────────┘               ┌─────────────┐
                                                   │SIFEN SOAP   │
                                                   │test / prod  │
                                                   └─────────────┘
```

---

## Fase 1 — Validar pipeline con cert real (FE-PY actual)

**No empezar Fase 2 hasta terminar esto.** Las sorpresas aparecen acá.

Duración: 1-2 días una vez con `.p12` en mano.

- [ ] Conseguir cert `.p12` del portal ekuatia.set.gov.py (ambiente test)
- [ ] Obtener CSC del portal ekuatia
- [ ] Completar `.env` local: `SIFEN_CERT_PATH`, `SIFEN_CERT_PASSWORD`, `SIFEN_CSC_ID`, `SIFEN_CSC`
- [ ] Ejecutar `node test-ui.js` → pipeline completo de punta a punta
- [ ] Recibir respuesta de SIFEN, confirmar "Aprobado"
- [ ] Consulta del CDC (`setapi.consulta`) para confirmar persistencia en SIFEN
- [ ] Emitir Nota de Crédito asociada a la factura emitida
- [ ] Cancelar factura de prueba (`setapi.evento` + `generateXMLEventoCancelacion`)
- [ ] **Documentar cada error encontrado** — son los bugs que hay que evitar en Fase 2
- [ ] Probar con `SIFEN_ENV=test` y también con ambiente real (solo consulta RUC, no emisión)

---

## Fase 2 — API comercial MVP

**Repo nuevo:** `facturacion-api` (separado de `FE-PY`). `FE-PY` queda como dependencia npm.

### 2.1 — Estructura del repo nuevo

```
facturacion-api/
├── src/
│   ├── app.ts                    # Fastify bootstrap
│   ├── config/env.ts             # zod-validated env vars
│   ├── db/
│   │   ├── schema.ts             # Drizzle schema
│   │   └── migrations/
│   ├── crypto/
│   │   ├── envelope.ts           # DEK/KEK encryption
│   │   └── cert-loader.ts        # p12 decrypt in memory
│   ├── storage/
│   │   ├── s3-client.ts          # MinIO/Spaces wrapper
│   │   └── index.ts              # upload/download abstractions
│   ├── queue/
│   │   ├── connection.ts         # Redis conn
│   │   └── workers/
│   │       ├── send-sifen.ts     # reintentos al enviar
│   │       ├── batch.ts          # lotes asíncronos
│   │       └── query-status.ts   # consulta periódica
│   ├── services/
│   │   ├── de.service.ts         # wrapper sobre xmlgen+xmlsign+qrgen+setapi
│   │   ├── numeracion.service.ts # secuencia con lock
│   │   ├── cert.service.ts       # upload, validate, rotate
│   │   └── evento.service.ts
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── tenants.ts
│   │   ├── documents.ts          # POST /de, GET /de/:cdc
│   │   ├── events.ts
│   │   └── consultas.ts          # ruc, lote
│   ├── middleware/
│   │   ├── auth.ts               # parse Bearer → company_id
│   │   ├── tenant-scope.ts       # verifica tenant pertenece a company
│   │   ├── idempotency.ts
│   │   └── error-handler.ts
│   └── lib/xsd-validator.ts      # xmllint subprocess
├── test/
│   ├── integration/              # contra SIFEN test con cert de CI
│   └── unit/
├── docker-compose.yml            # dev local: api + postgres + redis + minio
├── Dockerfile
├── drizzle.config.ts
├── package.json
└── PLAN.md (este)
```

### 2.2 — Schema DB (simplificado, Drizzle)

```ts
// companies ─── plataformas clientes del servicio
companies {
  id: uuid pk
  name: text
  email: text unique
  api_key_hash: text          // bcrypt del API key master
  api_key_prefix: text        // "cmp_abc123" primeros chars, para identificar sin revelar
  status: enum('active', 'suspended', 'deleted')
  billing_email: text
  created_at: timestamp
}

// tenants ─── contribuyentes emisores (los RUCs)
tenants {
  id: uuid pk
  company_id: uuid fk companies(id)    // ⚠ siempre filtrar por esto
  external_id: text                    // ID que usa la Company internamente (ej. su user_id)
  ruc: text                            // 8000001-1
  razon_social: text
  nombre_fantasia: text
  timbrado_numero: text
  timbrado_fecha: date
  timbrado_vencimiento: date
  tipo_contribuyente: smallint
  tipo_regimen: smallint
  establecimientos_json: jsonb         // array de estableci con dir, ciudad, dpto, etc
  actividades_economicas_json: jsonb
  env: enum('test', 'prod')
  status: enum('active', 'suspended')
  created_at: timestamp

  unique (company_id, ruc)             // el mismo RUC no puede estar 2 veces en la misma company
  index on company_id
}

// tenant_certs ─── certificados cifrados
tenant_certs {
  id: uuid pk
  tenant_id: uuid fk tenants(id)
  company_id: uuid fk companies(id)   // denormalizado para query rápida + RLS
  encrypted_p12: bytea                 // AES-256-GCM
  encrypted_dek: bytea                 // DEK cifrada con KEK master
  encrypted_password: bytea
  iv_p12: bytea
  iv_dek: bytea
  iv_password: bytea
  fingerprint: text                    // SHA256 del cert (dedupe)
  subject_cn: text
  subject_ruc: text                    // extraído del cert → debe coincidir con tenants.ruc
  not_before: timestamp
  not_after: timestamp                 // alerta a los 30 días
  uploaded_at: timestamp
  revoked_at: timestamp nullable

  unique (tenant_id)                   // un solo cert activo por tenant
}

// tenant_csc ─── CSC del tenant (separado por si rota independientemente del cert)
tenant_csc {
  tenant_id: uuid pk fk tenants(id)
  company_id: uuid fk
  csc_id: text
  csc_encrypted: bytea
  iv: bytea
  updated_at: timestamp
}

// documents ─── facturas/notas emitidas
documents {
  id: uuid pk                          // txn_id interno, devuelto al cliente
  company_id: uuid fk                  // ⚠ partition key lógica
  tenant_id: uuid fk
  cdc: text unique                     // 44 dígitos
  tipo: smallint                       // 1=FE, 5=NC (MVP)
  establecimiento: text
  punto: text
  numero: text
  fecha_emision: timestamp
  moneda: text
  monto_total: numeric(15,2)
  estado: enum('pendiente', 'firmando', 'enviando', 'aprobado', 'rechazado', 'error')
  sifen_response_raw: jsonb nullable
  sifen_codigo_respuesta: text nullable
  sifen_mensaje: text nullable
  xml_storage_key: text nullable       // 'xml/{company_id}/{tenant_id}/{cdc}.xml' en MinIO
  kude_storage_key: text nullable
  idempotency_key: text nullable
  error_message: text nullable
  retries: smallint default 0
  created_at: timestamp
  updated_at: timestamp

  unique (tenant_id, tipo, establecimiento, punto, numero)  // no duplicar numeración
  index (company_id, tenant_id, created_at desc)            // listado paginado
  index on cdc
}

// numeracion ─── secuencia por tenant/establecimiento/punto/tipo
numeracion {
  tenant_id: uuid fk
  tipo: smallint
  establecimiento: text
  punto: text
  ultimo_numero: bigint
  primary key (tenant_id, tipo, establecimiento, punto)
}
// uso: SELECT ... FOR UPDATE en transacción que inserta el document

// eventos ─── cancelación, inutilización, etc.
eventos {
  id: uuid pk
  company_id: uuid fk
  tenant_id: uuid fk
  document_cdc: text nullable          // null para inutilización
  tipo_evento: enum('cancelacion','inutilizacion','conformidad','disconformidad',...)
  xml_storage_key: text
  sifen_response_raw: jsonb
  estado: enum
  created_at: timestamp
}

// idempotency_keys ─── dedupe de POST /de
idempotency_keys {
  key: text                            // cliente manda header Idempotency-Key
  company_id: uuid fk
  tenant_id: uuid fk
  request_hash: text                   // SHA256 del body
  response_json: jsonb                 // respuesta cacheada
  created_at: timestamp
  expires_at: timestamp                // 24h TTL

  primary key (company_id, key)
}

// api_logs ─── auditoría (sin payloads sensibles)
api_logs {
  id: uuid pk
  company_id: uuid fk
  tenant_id: uuid fk nullable
  method: text
  path: text
  status_code: smallint
  duration_ms: int
  user_agent: text
  ip: inet
  created_at: timestamp
}
```

### 2.3 — Endpoints MVP (Factura + Nota de Crédito)

Todo bajo `/v1`, todos requieren `Authorization: Bearer cmp_key_*`.

```
# Company (auto-registro + admin de su cuenta)
POST   /v1/companies                      # signup → devuelve cmp_key
GET    /v1/companies/me                   # perfil + métricas de uso
POST   /v1/companies/me/keys/rotate       # rotar API key

# Tenants (CRUD de contribuyentes emisores, scoped a la company)
POST   /v1/tenants                        # crear tenant (RUC, timbrado, establec, etc.)
GET    /v1/tenants                        # listar tenants de la company
GET    /v1/tenants/:tenant_id             # detalle
PUT    /v1/tenants/:tenant_id             # actualizar config
DELETE /v1/tenants/:tenant_id             # soft delete
POST   /v1/tenants/:tenant_id/cert        # multipart: file=.p12, password=xxx
GET    /v1/tenants/:tenant_id/cert        # metadata (fingerprint, expiración) - nunca el .p12
PUT    /v1/tenants/:tenant_id/csc         # {csc_id, csc}
GET    /v1/tenants/:tenant_id/stats       # usage metrics

# Emisión
POST   /v1/tenants/:tenant_id/de                 # emitir DE síncrono (Factura o NC)
                                                 # body: datos del documento
                                                 # header: Idempotency-Key obligatorio
                                                 # → {txn_id, cdc, estado, xml_url, kude_url}
POST   /v1/tenants/:tenant_id/de/batch           # lote async → {job_id}
GET    /v1/tenants/:tenant_id/de/batch/:job_id   # estado del job

# Consulta de documentos emitidos
GET    /v1/tenants/:tenant_id/de                 # listar (filtros: fecha, estado, tipo)
GET    /v1/tenants/:tenant_id/de/:cdc            # detalle
GET    /v1/tenants/:tenant_id/de/:cdc/xml        # download XML firmado
GET    /v1/tenants/:tenant_id/de/:cdc/kude       # download KUDE pdf
POST   /v1/tenants/:tenant_id/de/:cdc/consulta   # force re-query a SIFEN

# Eventos (MVP: solo cancelación)
POST   /v1/tenants/:tenant_id/eventos/cancelacion  # {cdc, motivo}

# Consultas SIFEN
GET    /v1/consulta/ruc/:ruc                     # consulta RUC público
                                                 # usa el primer cert disponible de la company

# Health
GET    /v1/health                                 # liveness + readiness
```

**Convenciones importantes:**
- Todos los IDs son UUID v7 (ordenables por tiempo).
- `:tenant_id` en el path + middleware que verifica `tenant.company_id == req.company_id` — **si no coincide, 404** (no 403, para no revelar la existencia del tenant).
- `Idempotency-Key` obligatorio en `POST /de`. Misma key en <24h → devuelve la respuesta cacheada.
- Errores SIFEN se devuelven tal cual al cliente en `sifen_response`, con nuestro wrapper en `error.message`.

### 2.4 — Envelope encryption del certificado

El componente más delicado. Mal implementado = leak del cert de un cliente = juicio.

**Esquema:**

1. **KEK (Key Encryption Key) master** — AES-256, 32 bytes, guardada en variable de entorno `MASTER_KEY_BASE64`. Configurada en Coolify una sola vez. Backup offline.
2. **DEK (Data Encryption Key) por cert** — generada random al momento del upload, 32 bytes.
3. **Al subir `.p12`:**
   ```ts
   const dek = crypto.randomBytes(32);
   const ivP12 = crypto.randomBytes(12);
   const ivPwd = crypto.randomBytes(12);
   const ivDek = crypto.randomBytes(12);

   const encP12 = aes256gcmEncrypt(p12Buffer, dek, ivP12);
   const encPwd = aes256gcmEncrypt(Buffer.from(password), dek, ivPwd);
   const encDek = aes256gcmEncrypt(dek, KEK, ivDek);

   // guardar encP12, encPwd, encDek, ivP12, ivPwd, ivDek en DB
   // ⚠ dek y password se quedan en memoria solo mientras dure este scope
   dek.fill(0);
   ```
4. **Al firmar:**
   ```ts
   const row = await db.select().from(tenantCerts).where(...);
   const dek = aes256gcmDecrypt(row.encDek, KEK, row.ivDek);
   const p12 = aes256gcmDecrypt(row.encP12, dek, row.ivP12);
   const pwd = aes256gcmDecrypt(row.encPwd, dek, row.ivPwd).toString();

   // escribir .p12 en directorio temporal con perms 0600
   const tmpPath = path.join(os.tmpdir(), `${uuid()}.p12`);
   fs.writeFileSync(tmpPath, p12, { mode: 0o600 });
   try {
     const xmlFirmado = await xmlsign.signXML(xml, tmpPath, pwd);
     return xmlFirmado;
   } finally {
     fs.unlinkSync(tmpPath);
     dek.fill(0); p12.fill(0); Buffer.from(pwd).fill(0);
   }
   ```
5. **Validación al subir:** usar `node-forge` para:
   - Verificar que la password sea correcta
   - Extraer metadata: fingerprint, subject CN, RUC del cert, not_before, not_after
   - **Confirmar que el RUC del cert coincide con el RUC declarado en el tenant** — si no coincide, rechazar

**Defensa en profundidad:**
- Ninguna query/log imprime `encP12` ni `encPwd`
- Pino redacta automáticamente campos con esos nombres (`redact: ['*.encP12', '*.password', '*.p12']`)
- La KEK en env var jamás se imprime al arranque
- Monitoring: alerta si alguien intenta SELECT en `tenant_certs` fuera del pool de conexiones del worker de firma

**Upgrade futuro a KMS:**
Cuando el volumen justifique, mover la KEK a AWS KMS / HashiCorp Vault / Infisical.
Cambio aislado al archivo `src/crypto/envelope.ts`. El schema DB no cambia.

### 2.5 — Storage abstraction (MinIO ⇄ DO Spaces)

```ts
// src/storage/s3-client.ts
import { S3Client } from '@aws-sdk/client-s3';

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,         // minio: "http://minio:9000", spaces: "https://nyc3.digitaloceanspaces.com"
  region: env.S3_REGION,              // minio: "us-east-1" (dummy), spaces: "nyc3"
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',  // true para minio, false para spaces
});

export const BUCKET = env.S3_BUCKET;
```

El resto del código usa solo las abstracciones `uploadXml(key, buf)` / `getSignedUrl(key)`.
Migración MinIO → DO Spaces = cambiar 5 env vars en Coolify, nada más.

### 2.6 — Docker multi-stage

```dockerfile
# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-alpine
RUN apk add --no-cache libxml2-utils   # para xmllint
WORKDIR /app
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY xsd ./xsd
COPY xsd-unsigned ./xsd-unsigned
EXPOSE 3000
CMD ["node", "dist/app.js"]
```

### 2.7 — docker-compose local (dev)

```yaml
services:
  api:
    build: .
    environment:
      DATABASE_URL: postgres://postgres:postgres@postgres/facturacion
      REDIS_URL: redis://redis:6379
      S3_ENDPOINT: http://minio:9000
      S3_BUCKET: facturacion-dev
      S3_ACCESS_KEY: minioadmin
      S3_SECRET_KEY: minioadmin
      S3_FORCE_PATH_STYLE: "true"
      MASTER_KEY_BASE64: ${MASTER_KEY_BASE64}
    depends_on: [postgres, redis, minio]
    ports: ["3000:3000"]

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: facturacion
    volumes: ["pgdata:/var/lib/postgresql/data"]

  redis:
    image: redis:7-alpine
    volumes: ["redisdata:/data"]

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    ports: ["9000:9000", "9001:9001"]
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes: ["miniodata:/data"]

volumes: { pgdata, redisdata, miniodata }
```

### 2.8 — Entregables del MVP (definition of done)

- [ ] Repo `facturacion-api` creado con la estructura de arriba
- [ ] Schema DB + migraciones Drizzle
- [ ] Envelope encryption con tests unitarios (encrypt/decrypt round trip + tampering detection)
- [ ] Endpoints listados en 2.3, todos tenant-scoped
- [ ] `docker-compose up` levanta todo en local
- [ ] Cliente de prueba (curl/Postman collection) que recrea el flujo completo
- [ ] Test de integración end-to-end contra SIFEN test (cert dedicado de CI)
- [ ] README con quickstart
- [ ] Deploy a Coolify en staging
- [ ] 1 Company + 1 Tenant de prueba emitiendo facturas reales en SIFEN test
- [ ] **1 cliente real enchufado** emitiendo al menos 1 factura por día

**Duración estimada:** 3-4 semanas full time (volumen medio estimado 1K-50K facturas/día).

---

## Fase 3 — Hardening de producción

Se puede hacer en paralelo con primeros clientes.

- [ ] Eventos restantes: inutilización, conformidad, disconformidad, desconocimiento, notificación
- [ ] Soporte resto de tipos de DE: Nota de Débito, Autofactura, Remisión
- [ ] Generación KUDE (PDF visual de la factura) con `facturacionelectronicapy-kude`
- [ ] Webhooks por company — notificamos cambios de estado de DEs async
- [ ] Panel admin (Next.js?) para que las companies vean métricas, errores, certs por expirar
- [ ] Rate limiting por company (Redis token bucket)
- [ ] Rotación automática de API keys (schedule + comunicación)
- [ ] Alertas Sentry por error-rate y por certs próximos a vencer
- [ ] Backups Postgres automatizados (daily) + restore probado mensual
- [ ] Métricas Prometheus + Grafana (req/s por company, latencia firma, error SIFEN por tipo)
- [ ] Compliance: retención 5 años de XMLs según ley 6534/2020, proceso de borrado GDPR-like
- [ ] OpenAPI spec auto-generado desde Fastify schemas + Swagger UI público
- [ ] Documentación dev portal (cómo integrar desde un POS)
- [ ] Migración MinIO → DO Spaces cuando el tráfico lo justifique
- [ ] Upgrade KEK a KMS (AWS o HashiCorp Vault)
- [ ] Observability: OpenTelemetry tracing — spans por request con tenant_id/company_id
- [ ] Soporte para versión futura del manual SIFEN (v160+)

---

## Cronograma tentativo

| Semana | Entregable |
|---|---|
| 0 (ya) | Fase 1: pipeline local con cert de prueba funciona end-to-end |
| 1 | Repo `facturacion-api` creado, schema DB, envelope encryption con tests |
| 2 | Endpoints `/companies`, `/tenants`, `/tenants/:id/cert`, auth middleware |
| 3 | `POST /de` síncrono funcionando contra SIFEN test, idempotencia, numeración |
| 4 | Docker + docker-compose + deploy Coolify staging, Nota de Crédito, cancelación |
| 5 | Primer cliente real integrado en staging, fix de bugs |
| 6 | Prod deploy, primera factura real emitida por cliente de un cliente |

---

## Riesgos

1. **Cert SIFEN inválido o mal configurado** — probabilidad alta, detectable solo en Fase 1. Mitigación: Fase 1 primero, no empezar Fase 2 hasta que funcione.
2. **Leak del cert de un cliente** — riesgo catastrófico. Mitigación: envelope encryption + tests de tampering + nunca loguear cert/password + auditoría manual del código del módulo crypto.
3. **Números duplicados por race conditions** — SIFEN rechaza, cliente se enoja. Mitigación: `SELECT FOR UPDATE` en transacción DB + tests de concurrencia.
4. **SIFEN caído** — pasa. Mitigación: cola BullMQ con reintentos exponenciales + endpoint async `/de/batch` + estado `pendiente`/`reintentando` visible al cliente.
5. **Timbrado vencido** — causa rechazo SIFEN con mensaje confuso. Mitigación: validación al crear tenant + alerta 30 días antes del vencimiento.
6. **Competencia establecida** (FacturaSend, Factupar, Datamex) usa los mismos módulos open source. Mitigación: diferencial tiene que ser DX del API, latencia, soporte, precio, o vertical específico. **No es un problema técnico sino comercial — ya tienen clientes esperando, así que asumimos está resuelto.**

---

## Notas importantes

- Este repo (`FE-PY`) queda como **motor**: generación + validación + firma + envío. El API lo consume como dependencia npm (o fork privado si hay que parchear).
- El cert `.p12` que uses en Fase 1 debe ser dedicado al desarrollo — **no reutilizar certs de clientes reales para debugging**.
- Cuando empieces a firmar XMLs en Fase 2, guardá los primeros 10 XMLs firmados en un lado seguro para poder validarlos manualmente contra SIFEN test y debuggear si algo sale mal.
- **Ley aplicable:** ley 6534/2020 Paraguay (protección de datos personales), Resolución General 90/2021 SET (facturación electrónica). Leer antes de ir a prod con clientes reales.
