# Hand-off — 2026-09-07

## Objetivo
Primera validación end-to-end del motor FE-PY contra **SIFEN producción**
(no test) con certificado real de un cliente real, para confirmar que el
pipeline completo (firma → envío → aprobación → consulta → KUDE → eventos)
funciona antes de ofrecerlo a Punto/Factomate como reemplazo del emisor
actual del cliente.

## Estado al cerrar
Emisión real lograda y verificada contra SIFEN prod: factura 001-002-0000612
(aprobada 0260, luego anulada por evento 0600), 613 (consumidor final,
aprobada), 614 (B2B, aprobada, protocolo `3549281396`), NC 001-002-0000002
contra la 614 (aprobada, protocolo `3549281825`). Consulta WS calibrada
(0422 = CDC encontrado). KUDE genera PDF OK **verificado a mano dentro del
container**, pero el fix (commit `448c885`) **no está activo** — falta
rebuild de la imagen. Todo esto está commiteado (`65351e4..fc6161b`) pero
**nada está pusheado ni deployado**; sigue corriendo en Docker local del
laptop del owner.

## Archivos y cambios
- `api/src/services/de.service.ts` — pipeline por recibeLote/consultaLote (69d1d76), fix timezone firma (cb2afbb)
- `api/src/services/kude.service.ts` — toma el `.pdf` real del tmpdir en vez de asumir `<CDC>.pdf` (448c885), loguea motivo de fallo (c03b1db)
- `api/Dockerfile` — JRE completo + fontconfig/libfontmanager para JasperReports (3eec404)
- `PUNTO_INTEGRATION.md` — contrato de endpoints para la sesión Punto (adapter FePyProvider), ya al día, no tocar
- `NEXT_STEPS.md` — actualizado esta sesión (ver docs abajo)
- `api/.env` (NO commiteado, gitignored) — `ENABLE_SIFEN=true`, `ENABLE_KUDE=true`, `MASTER_KEY` dev

## Callejones sin salida
1. Servicio síncrono `recibe` de SIFEN está **restringido en producción**: devuelve 1264 "RUC no habilitado" aunque el RUC sí esté habilitado — no es problema de habilitación, el canal real es recibeLote+consultaLote.
2. Rechazo 1004 "firma adelantada" = container en UTC, SIFEN interpreta todo en America/Asuncion — no es reloj desincronizado.
3. Rechazo 1107 = timbradoFecha no coincide con Marangatú. El dato "de memoria" del owner (2026-02-06) era falso; el real (2025-08-26) salió de un KUDE del sistema anterior. **Nunca estimar timbradoFecha.**
4. Rechazo 1331: NC contra factura a consumidor final innominado — SIFEN exige receptor identificado (CI/RUC) en toda NC. Implicación de producto para el POS.
5. KUDE fallaba por dos capas simultáneas (JRE sin libfontmanager + nombre de archivo del JAR distinto al asumido) — un solo fix no alcanzaba, había que resolver ambas.
6. `dProtConsLote` tiene 19 dígitos, > `Number.MAX_SAFE_INTEGER` — manejar siempre como string.
7. Documento rechazado deja fila en `documents` con el número consumido; el UNIQUE(tenant, numero) rompe el reintento con 500 — hoy se borra la fila a mano por SQL.

## Próximo paso
`docker compose -f api/docker-compose.yml up --build -d api` para activar el
fix de KUDE (448c885) — hoy solo está verificado a mano dentro del
container viejo, no en el flujo real del servicio.

## Trampas conocidas
- Numeración sembrada a mano por SQL en la DB local; próximo correlativo FE real es **615**, NC **3**.
- Fila `documents` de la 612 se corrigió a mano por SQL (estado aprobado + protocolo) antes de cancelarla — no viene de un flujo normal.
- Worker BullMQ **no corre** en el compose local (profile "workers" apagado) — retry y batch async no procesan hoy.
- API corre en `localhost:3001` (3000 ocupado por otro dev server del owner) — no asumir el puerto default.
- Punto configuró Factomate DEV con punto 001-002, que colisiona con el 001-002 exclusivo de FE-PY — propuesta acordada (Factomate=001-001, FE-PY=001-002) **pendiente de confirmación del owner**.
- Portal público ekuatia tiene captcha (no verificable por agente); el WS de consulta no lo tiene — usar el WS para chequeos automatizados.
- razonSocial debe ser la del padrón RUC ("GONZALEZ QUEVEDO, CINTIA ESTEFANIA"), no el nombre comercial del cliente.
- Pendiente de deploy: Coolify en server Punto (167.71.165.221), MASTER_KEY prod nueva + backup, gating `/playground`, re-provisioning completo en server — nada de esto se tocó esta sesión.
