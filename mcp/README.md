# fepy-mcp — Facturación electrónica (SIFEN Paraguay) para agentes IA

Servidor MCP que expone FE-PY a Claude y cualquier agente compatible con
Model Context Protocol. Un agente puede emitir facturas y notas de crédito,
anular documentos, consultar estados y verificar el padrón — con las mismas
validaciones y auditoría del API.

## Herramientas

| Tool | Qué hace |
|---|---|
| `emitir_factura` | FE legal en SIFEN (consumidor final, CI o RUC; contado/crédito; numeración automática o explícita) |
| `emitir_nota_credito` | NC contra una factura aprobada (requiere receptor identificado) |
| `cancelar_documento` | Anulación por evento SIFEN (ventana 48h, irreversible) |
| `consultar_documento` | Detalle + estado + links XML/KUDE por CDC |
| `listar_documentos` | Historial del tenant |
| `estado_tenant` | Readiness: cert, CSC, numeración, RUC |
| `consultar_ruc` | Padrón SIFEN (razón social oficial) |

## Modo local (stdio) — Claude Code / Claude Desktop

```bash
cd mcp && npm install

claude mcp add fepy \
  -e FEPY_URL=https://fepy.punto.la \
  -e FEPY_API_KEY=cmp_xxx \
  -e FEPY_TENANT_ID=<uuid-del-tenant> \
  -- node /ruta/absoluta/FE-PY/mcp/server.mjs
```

`FEPY_TENANT_ID` es opcional — sin él, cada tool pide `tenant_id`.

## Modo remoto (HTTP streamable) — connectors / multi-agente

```bash
FEPY_URL=https://fepy.punto.la MCP_HTTP_PORT=3100 node server.mjs
```

- Endpoint MCP: `http://host:3100/mcp` — health: `/health`
- **Auth por request**: cada cliente manda su API key de FE-PY en
  `Authorization: Bearer cmp_...` (multi-company nativo). `FEPY_API_KEY`
  del entorno actúa solo de fallback.
- Deploy en Coolify: app nueva del mismo repo, dockerfile no hace falta —
  buildpack Nixpacks con start command `node mcp/server.mjs`, env
  `FEPY_URL` + `MCP_HTTP_PORT=3100`, dominio p.ej. `mcp.fepy.punto.la`.

## Advertencia

`emitir_factura`, `emitir_nota_credito` y `cancelar_documento` generan
documentos **fiscales reales** cuando el tenant está en `env=prod`. Las
descripciones de las tools instruyen al agente a confirmar con el usuario
antes de emitir; la última línea de defensa es el sistema de permisos del
cliente MCP (aprobación por tool call).
