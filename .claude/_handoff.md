# Hand-off — 2026-09-17

## Objetivo
Destrabar la emisión real de Balloon Party en 001-001 (rechazo 1110 por
serie mal asumida), blindar el KUDE contra recorte de datos fiscales, y
darle al owner un panel propio para operar sin depender de un agente.

## Estado al cerrar
Commiteado, pusheado (`ee77890..f0d7c1f`, 11 commits) y **deployado** en
Coolify (API healthy; worker healthy hasta antes de `f0d7c1f`, que solo
tocó la API). Mig 0008 (`numeracion.serie` + CDC parcial) corrida en prod.
Serie "AA" de 001-001 cargada y confirmada: 840/841 APROBADAS, 001-001
destrabado. Panel `/admin` activo con `ADMIN_TOKEN`, owner ya anuló y emitió
NC total desde ahí. **A medias:** Remisión (tipo 7) implementada pero NUNCA
emitida contra SIFEN real. Cantidad fraccionaria en KUDE sin decimales
(`dCantProSer` Integer en el Jasper, requiere recompilar template).

## Archivos y cambios
- `lib/de-validation.ts`, `api/src/routes/de.ts` — reglas por tipo, corren antes de reservar número
- `api/src/routes/geo.ts` (nuevo) — catálogo `/v1/geo`
- `api/src/db/migrations/0008_*.sql` — `numeracion.serie` + índice CDC parcial
- `api/src/services/document-lookup.ts`, `tenant-cert.ts` — `findDocumentByCdc`, `withTenantCertFile`
- `api/kude-templates/` — Jasper parcheado SCALE_FONT (usar siempre estos, no los de `node_modules`)
- `api/kude-patch/` (nuevo) — auditoría reproducible de recorte fiscal (Audit.java, Docker con fuentes de prod)
- `api/src/routes/admin/*`, `api/public/admin/` — panel: 6 endpoints lectura + anular/nc-total, UI rediseñada
- `NEXT_STEPS.md` — actualizado (fila remisión, panel ya no es solo-lectura)

## Callejones sin salida
- Serie "AA" NO se deduce de código viejo (Factomate, descartado) — se lee de `<dSerieNum>` del XML aprobado en SIFEN (por eso existe `GET /consulta/de/:cdc`).
- Ciudad 145 = distrito de Ciudad del Este, NO Encarnación (2226) — verificar geo contra tablas de xmlgen, no memoria.
- Parche KUDE de un solo campo (CDC) fue insuficiente; auditoría con fuentes de prod encontró más recortes. En macOS la auditoría da falsos negativos (fuentes angostas) — correr con Docker de fuentes de prod.
- 2 subagentes de rediseño UI se colgaron (stall 600s); funcionó hacerlo inline con `window.fetch` stubbeado sirviendo el HTML.
- Sondear deploy con "¿404 en /admin?" da falso positivo (build viejo también 404); usar señal exclusiva del build nuevo (401 del gate).

## Próximo paso
Confirmar con Punto/SIFEN si el timbrado de Balloon Party tiene tipo 7
habilitado y hacer una emisión real de remisión de prueba.

## Trampas conocidas
- `ADMIN_TOKEN` generado a mano y cargado en Coolify (solo API, no worker) — no está en ningún commit.
- Serie "AA" cargada a mano por el owner, no por un endpoint del repo.
- Las 2 NC pendientes de Punto ya se emitieron desde el panel y están APROBADAS; Punto debe marcar sus devoluciones con esos CDC, correr su correlativo y frenar el reintento de su NC huérfana (001-002-0000002, rechazada 1002: ese número lo consumió una NC de pruebas del 08/09 aprobada en SIFEN cuya fila local se borró al purgar el tenant viejo — SIFEN no se entera de purgas locales).
- Punto ya deployó su lado (serie por punto en el body de cada POST /de).
- Regla de memoria del agente: datos fiscales nunca se recortan/redondean en documentos generados; auditar contra fuentes de prod antes de dar un fix por bueno.
