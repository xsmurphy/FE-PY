# Bitácora de sesiones — FE-PY

Índice histórico, orden cronológico inverso (más reciente arriba). Detalle
completo vive en los commits y en `_handoff.md` (estado de la sesión más
reciente).

## 2026-09-08 (madrugada) — API deployada en producción: https://fepy.punto.la

Commits `2958042..bd617d1` (5). Highlights: 3 blockers pre-prod resueltos (playground gated, endpoint numeración `/v1/tenants/:id/numeracion`, índice único parcial en `documents` para no bloquear número tras rechazo, mig 0002); deploy en Coolify (server Punto 167.71.165.221) tras 4 intentos fallidos — Dockerfile path, `NODE_ENV=production` mataba devDeps (fix `--include=dev`), healthcheck `localhost`→IPv6 sin resolver (fix `127.0.0.1`); provisioning prod ejecutado (tenant Balloon Party, cert, CSC, numeración FE=614/NC=2). Blocker crítico pendiente: `timbradoFecha` prod mal cargada (2026-02-06, la real es 2025-08-26).

## 2026-09-07 — primera validación E2E SIFEN producción: 612 anulada, 613/614/NC aprobadas

Commits `65351e4..fc6161b` (10). Highlights: pipeline DE por recibeLote/consultaLote (canal real, `recibe` síncrono restringido en prod con 1264); fix timezone firma/dFeEmiDE (rechazo 1004); factura 001-002-0000612 aprobada→anulada (evento 0600), 613 y 614 (protocolo 3549281396) aprobadas, NC 0000002 (protocolo 3549281825) aprobada; KUDE fix JRE+fontconfig+nombre real del PDF (falta rebuild); consulta WS calibrada (0422 CDC encontrado). Cliente real: Balloon Party, RUC 3595193-1, punto 001-002.
