# facturacion-api

API comercial multi-tenant de facturación electrónica Paraguay (SIFEN).
Motor bajo el capó: `facturacionelectronicapy-xmlgen` (este mismo repo, carpeta raíz).

Estado: **scaffolding inicial**. Lo que hay funcionando:

- Fastify 5 + TypeScript + zod schemas
- Drizzle ORM + Postgres (9 tablas, migraciones generadas)
- Envelope encryption AES-256-GCM (KEK/DEK) con tests unitarios
- Error handler centralizado
- Auth middleware (Bearer `cmp_*` API key)
- Logger pino con redacción de campos sensibles
- Ruta `POST /v1/companies` (signup) + `GET /v1/companies/me`
- Health checks
- Docker multi-stage
- docker-compose con api + postgres + redis + minio

Pendiente: rutas de tenants, certs, emisión DE, eventos, cola BullMQ,
cert service con node-forge, storage abstraction, integración con el motor.

## Quickstart local (sin Docker)

```bash
cd api
cp .env.example .env

# Generar la MASTER_KEY y copiarla a .env
node -e "console.log('MASTER_KEY_BASE64=' + require('crypto').randomBytes(32).toString('base64'))"

# Levantar solo postgres/redis/minio con Docker
docker compose up -d postgres redis minio minio-init

npm install
npm run db:generate   # genera migración SQL desde schema.ts
npm run db:migrate    # aplica migraciones
npm run dev           # arranca con watch
```

Probar:

```bash
curl http://localhost:3000/v1/health
curl http://localhost:3000/v1/health/ready
curl -X POST http://localhost:3000/v1/companies \
  -H 'content-type: application/json' \
  -d '{"name": "Acme POS", "email": "admin@acme.com"}'
```

## Quickstart con Docker completo

```bash
cd api
cp .env.example .env
# generar MASTER_KEY_BASE64 y pegarla en .env (o exportarla)
export MASTER_KEY_BASE64="$(node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"base64\"))')"

docker compose up --build
```

## Tests

```bash
npm test              # one-shot
npm run test:watch    # watch mode
```

Tests importantes:
- `test/crypto/envelope.test.ts` — round trip, tampering detection, KEK rotation

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | tsx watch, reload on change |
| `npm run build` | TypeScript → `dist/` |
| `npm start` | corre `dist/server.js` |
| `npm run typecheck` | tsc --noEmit |
| `npm run db:generate` | genera migración SQL desde `schema.ts` |
| `npm run db:migrate` | aplica migraciones pendientes |
| `npm run db:studio` | abre Drizzle Studio en el browser |
| `npm test` | Vitest |

## Arquitectura

Ver [`../PLAN.md`](../PLAN.md) para diseño completo, schema de DB, endpoints,
y cronograma. Este README solo describe el estado del scaffolding.

## Variables de entorno

Ver [`.env.example`](.env.example). Las más importantes:

- `DATABASE_URL` — Postgres connection string
- `REDIS_URL` — Redis para cola + idempotency + rate limit
- `S3_*` — endpoint S3 (MinIO en dev, DO Spaces en prod)
- `MASTER_KEY_BASE64` — **KEK de 32 bytes en base64**, backup offline obligatorio
- `ENABLE_SIFEN` — `false` mientras no haya cert, `true` para pipeline completo

## Diseño de secretos

El certificado `.p12` del cliente nunca se guarda en claro. Esquema en
[`src/crypto/envelope.ts`](src/crypto/envelope.ts):

1. Al subir el cert, se genera una DEK random de 32 bytes
2. Se cifra el `.p12` con AES-256-GCM usando la DEK
3. Se cifra la DEK con la KEK master (también AES-256-GCM)
4. Se guardan en DB: `{ciphertext, iv, tag, encryptedDek, ivDek, tagDek}`
5. Al firmar: se descifra la DEK con la KEK, luego el `.p12` con la DEK,
   se usa en memoria, y se zero-ea el buffer al terminar

La KEK master vive solo en variable de entorno `MASTER_KEY_BASE64` (32 bytes
base64). Si se pierde, **todos los certs quedan inaccesibles** — backup offline
obligatorio.
