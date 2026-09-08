# Hand-off — 2026-09-08 (madrugada)

## Objetivo
Pasar el motor FE-PY (ya validado E2E contra SIFEN producción el 2026-09-07)
de "corriendo en Docker local del laptop del owner" a un deploy real en
internet, para poder ofrecerlo a Punto/Factomate como reemplazo del emisor
actual de Balloon Party.

## Estado al cerrar
**API en producción y funcionando: https://fepy.punto.la** — deployada en
Coolify sobre el server de Punto (167.71.165.221, proyecto Punto, app
"Factura Electrónica", uuid `5oj0o6wz7nmwkpez0ffeupej`). TLS ok, health+DB
ok, `/playground` da 404 (gated), `/docs` público. DBs propias en el mismo
Coolify: `fepy-db` (Postgres 16) + `fepy-redis`. Storage: DO Spaces del
owner (env `S3_*` cargadas). Auto-deploy por push está **desactivado** a
pedido del owner — todo deploy es manual (yo puedo dispararlo vía MCP
`coolify deploy`).

Provisioning prod ya ejecutado por el owner: company
`01a07f03-7119-7169-ac27-f14b6084e0d2`, tenant Balloon Party
`01a07f03-7335-7739-9869-296d3607797d` (env=prod), cert cargado (vence
2027-02-02), CSC `0001`, numeración FE=614/NC=2 (próximos 615/3).

Todo commiteado y **pusheado** a `github.com/xsmurphy/FE-PY` main
(`2958042..bd617d1`). Tests 54/54 verdes.

**No deployado ni resuelto todavía**: worker BullMQ (retries/batch async no
corren en prod), servicio de emisión de prueba desde prod, hand-off de
credenciales a la sesión Punto.

## Archivos y cambios
- `api/src/routes/tenants.ts` — `PUT/GET /v1/tenants/:id/numeracion` (correlativo con guard 409), numeración dual (body.numero explícito del ERP sincroniza con GREATEST)
- `api/src/db/migrations/0002_*.sql` — índice único PARCIAL en `documents` (rechazado/error no bloquean número)
- `api/src/routes/playground.ts` — gated detrás de `ENABLE_PLAYGROUND` (default false)
- `api/Dockerfile` — `--include=dev` en builders (Coolify inyecta `NODE_ENV=production` al build)
- healthcheck de la imagen — `curl 127.0.0.1` en vez de `wget localhost`
- `PUNTO_INTEGRATION.md` — doc de contrato Punto, modos de numeración
- `NEXT_STEPS.md` — actualizado esta sesión (hosting prod + blockers)

## Callejones sin salida
1. Dockerfile location mal configurada en Coolify (`/Dockerfile` en vez de
   `/api/Dockerfile`) — build context sigue siendo `/`.
2. Coolify inyecta `NODE_ENV=production` en el build, no solo en runtime →
   `npm install` omite devDependencies → `tsc: not found`. Fix:
   `--include=dev` explícito en el Dockerfile.
3. Healthcheck con `wget localhost` — Alpine resuelve `::1` (IPv6) primero,
   Fastify solo escucha IPv4 → `connection refused` con el server sano.
   Coolify SÍ gatea el deploy con el docker health status (local nunca lo
   miró, por eso "andaba en local"). Fix: `curl 127.0.0.1`.
4. Cancelar un deploy duplicado (webhook + API disparados sobre el mismo
   commit) mató también el build bueno — no cancelar deploys concurrentes
   del mismo commit en Coolify, esperar a que uno termine.
5. Intento de crear droplet propio DO "fe-py" (s-2vcpu-4gb nyc3): bloqueado
   por saldo pendiente en la cuenta DigitalOcean del owner — por eso se usó
   el server de Punto como hosting temporal en vez de infra propia.

## Próximo paso
**Corregir `timbradoFecha` del tenant prod** — está cargada como
`2026-02-06` (mal) y la real es `2025-08-26`; hasta que se corrija, toda
emisión rebota con SIFEN 1107. Ejecutar:

```
export FEPY_URL=https://fepy.punto.la FEPY_STATE=prod
node provision.js timbrado-fecha 2025-08-26
```

(script en el scratchpad de la sesión anterior, puede no existir mañana).
Si no está: `PATCH /v1/tenants/01a07f03-7335-7739-9869-296d3607797d` con
body `{"timbradoFecha":"2025-08-26"}` y el API key de `company.prod.json`.

Después, en orden: hand-off de credenciales a Punto (scp de
`fepy-handoff.json`, comando ya en el chat con el owner) → crear servicio
WORKER en Coolify (duplicar app, start command `worker`) → avisar a la
sesión Punto (`local_5c09615b-2531-438e-b575-857b0ceea283`) para el flip →
emisión de prueba desde prod (`provision.js emitir`) → cuando el owner
salde DigitalOcean, migrar a droplet propio.

## Trampas conocidas
- El scratchpad de la sesión anterior
  (`/private/tmp/claude-501/.../scratchpad/`) tiene `company.prod.json`
  (API KEY de prod) y `provision.js` — es temporal, **mover el API key a
  un lugar seguro antes de perderlo**; si se pierde se rota con
  `POST /companies/me/keys/rotate` (requiere el key actual).
- La `MASTER_KEY` de prod quedó impresa en el terminal del owner (generada
  a mano) — recomendar limpiar historial; ya está cargada en Coolify.
- `S3_KEY_PREFIX` en las env de Coolify no existe en el API, se ignora.
- El clasificador de permisos bloquea al agente para SSH al server,
  comandos con secretos e INSERT/UPDATE SQL directo — el owner los corre a
  mano.
- Sesión Punto está esperando green light para el flip de FePyProvider —
  no avisar hasta que el timbradoFecha y el hand-off de credenciales estén
  resueltos.
