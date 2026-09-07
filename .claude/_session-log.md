# Bitácora de sesiones — FE-PY

Índice histórico, orden cronológico inverso (más reciente arriba). Detalle
completo vive en los commits y en `_handoff.md` (estado de la sesión más
reciente).

## 2026-09-07 — primera validación E2E SIFEN producción: 612 anulada, 613/614/NC aprobadas

Commits `65351e4..fc6161b` (10). Highlights: pipeline DE por recibeLote/consultaLote (canal real, `recibe` síncrono restringido en prod con 1264); fix timezone firma/dFeEmiDE (rechazo 1004); factura 001-002-0000612 aprobada→anulada (evento 0600), 613 y 614 (protocolo 3549281396) aprobadas, NC 0000002 (protocolo 3549281825) aprobada; KUDE fix JRE+fontconfig+nombre real del PDF (falta rebuild); consulta WS calibrada (0422 CDC encontrado). Cliente real: Balloon Party, RUC 3595193-1, punto 001-002.
