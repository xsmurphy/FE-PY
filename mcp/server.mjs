#!/usr/bin/env node
/**
 * fepy-mcp — MCP server para FE-PY (facturación electrónica SIFEN, Paraguay).
 *
 * Permite que Claude u otros agentes IA emitan y gestionen documentos
 * electrónicos a través del API de FE-PY.
 *
 * Configuración por variables de entorno:
 *   FEPY_URL        Base del API (ej: https://fepy.punto.la) — requerida
 *   FEPY_API_KEY    API key de la company (cmp_...) — requerida
 *   FEPY_TENANT_ID  Tenant (contribuyente) por defecto — opcional; si no se
 *                   setea, cada tool exige el parámetro tenant_id
 *
 * Ejemplo (Claude Code):
 *   claude mcp add fepy \
 *     -e FEPY_URL=https://fepy.punto.la \
 *     -e FEPY_API_KEY=cmp_xxx \
 *     -e FEPY_TENANT_ID=<uuid> \
 *     -- node /ruta/a/FE-PY/mcp/server.mjs
 *
 * ADVERTENCIA: `emitir_factura`, `emitir_nota_credito` y `cancelar_documento`
 * generan DOCUMENTOS FISCALES REALES cuando el tenant está en env=prod.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

const BASE = process.env.FEPY_URL?.replace(/\/$/, '');
const ENV_API_KEY = process.env.FEPY_API_KEY;
const DEFAULT_TENANT = process.env.FEPY_TENANT_ID;
const HTTP_PORT = process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : null;

if (!BASE) {
  console.error('[fepy-mcp] Falta FEPY_URL en el entorno');
  process.exit(1);
}
if (!HTTP_PORT && !ENV_API_KEY) {
  console.error('[fepy-mcp] En modo stdio se requiere FEPY_API_KEY');
  process.exit(1);
}

// En modo HTTP cada cliente manda SU api key de FE-PY en el header
// Authorization (Bearer cmp_...); FEPY_API_KEY del entorno queda de fallback.
const requestContext = new AsyncLocalStorage();
const currentApiKey = () => requestContext.getStore()?.apiKey ?? ENV_API_KEY;

// ─────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────
const api = async (method, path, body) => {
  const apiKey = currentApiKey();
  if (!apiKey) throw new Error('Sin API key: mandá Authorization: Bearer cmp_... o configurá FEPY_API_KEY');
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(method === 'POST' && path.endsWith('/de')
        ? { 'idempotency-key': crypto.randomUUID() }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error?.message ?? text;
    const details = json?.error?.details ? `\nDetalles: ${JSON.stringify(json.error.details)}` : '';
    throw new Error(`FE-PY ${res.status}: ${msg}${details}`);
  }
  return json;
};

const tenantOf = (args) => {
  const t = args.tenant_id ?? DEFAULT_TENANT;
  if (!t) throw new Error('Falta tenant_id (no hay FEPY_TENANT_ID por defecto configurado)');
  return t;
};

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({
  isError: true,
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
});

// ─────────────────────────────────────────────────────────────────
// Schemas compartidos
// ─────────────────────────────────────────────────────────────────
const tenantIdSchema = z
  .string()
  .uuid()
  .optional()
  .describe('Tenant (contribuyente emisor). Opcional si FEPY_TENANT_ID está configurado.');

const itemSchema = z.object({
  codigo: z.string().describe('Código interno del producto/servicio, ej "A-001"'),
  descripcion: z.string().describe('Descripción que aparece en la factura'),
  cantidad: z.number().positive(),
  precioUnitario: z.number().positive().describe('Precio unitario en la moneda del documento (IVA incluido)'),
  iva: z.union([z.literal(0), z.literal(5), z.literal(10)]).default(10).describe('Tasa de IVA: 0 (exenta), 5 o 10'),
});

const clienteSchema = z
  .object({
    ruc: z.string().optional().describe('RUC del cliente contribuyente (con o sin DV, ej "7659394-0"). Si se da, la factura sale B2B.'),
    razonSocial: z.string().optional().describe('Razón social EXACTA del padrón (para RUC) o nombre completo (para CI)'),
    ci: z.string().optional().describe('Cédula de identidad, para cliente persona sin RUC'),
  })
  .optional()
  .describe('Cliente/receptor. Omitir para consumidor final innominado ("Sin Nombre").');

// Convierte el cliente simplificado al shape completo del API
const buildCliente = (c) => {
  const base = {
    direccion: 'Asuncion',
    numeroCasa: '0',
    departamento: 1,
    departamentoDescripcion: 'CAPITAL',
    distrito: 1,
    distritoDescripcion: 'ASUNCION (DISTRITO)',
    ciudad: 1,
    ciudadDescripcion: 'ASUNCION (DISTRITO)',
    pais: 'PRY',
    paisDescripcion: 'Paraguay',
    codigo: '000',
  };
  if (c?.ruc) {
    return {
      ...base,
      contribuyente: true,
      ruc: c.ruc,
      razonSocial: c.razonSocial ?? '',
      nombreFantasia: c.razonSocial ?? '',
      tipoOperacion: 1,
      tipoContribuyente: 1,
      documentoTipo: 1,
      documentoNumero: c.ruc.split('-')[0],
    };
  }
  if (c?.ci) {
    return {
      ...base,
      contribuyente: false,
      razonSocial: c.razonSocial ?? 'Sin Nombre',
      nombreFantasia: c.razonSocial ?? 'Sin Nombre',
      tipoOperacion: 2,
      documentoTipo: 1,
      documentoNumero: c.ci,
    };
  }
  return {
    ...base,
    contribuyente: false,
    razonSocial: 'Sin Nombre',
    nombreFantasia: 'Sin Nombre',
    tipoOperacion: 2,
    documentoTipo: 5,
    documentoNumero: '0',
  };
};

const buildItems = (items) =>
  items.map((i) => ({
    codigo: i.codigo,
    descripcion: i.descripcion,
    unidadMedida: 77,
    cantidad: i.cantidad,
    precioUnitario: i.precioUnitario,
    cambio: 0,
    descuento: 0,
    anticipo: 0,
    pais: 'PRY',
    paisDescripcion: 'Paraguay',
    ivaTipo: i.iva === 0 ? 3 : 1,
    ivaProporcion: 100,
    iva: i.iva,
  }));

const resumen = (r) => ({
  cdc: r.cdc,
  estado: r.estado,
  numero: `${r.establecimiento}-${r.punto}-${r.numero}`,
  montoTotal: r.montoTotal,
  moneda: r.moneda,
  sifen: r.sifen,
  kudeUrl: r.kudeUrl,
  xmlUrl: r.xmlUrl,
});

// ─────────────────────────────────────────────────────────────────
// Server + tools
// ─────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'fepy', version: '0.1.0' });

server.tool(
  'emitir_factura',
  'Emite una FACTURA ELECTRÓNICA legal en SIFEN (Paraguay) a través de FE-PY. ' +
    'ATENCIÓN: en un tenant de producción esto genera un documento fiscal REAL con validez tributaria — ' +
    'confirmar SIEMPRE con el usuario monto, ítems y cliente antes de llamar. ' +
    'Devuelve CDC, estado (aprobado/rechazado con motivo de SIFEN) y links a XML/KUDE.',
  {
    tenant_id: tenantIdSchema,
    establecimiento: z.string().regex(/^\d{1,3}$/).describe('Establecimiento, ej "001"'),
    punto: z.string().regex(/^\d{1,3}$/).describe('Punto de expedición, ej "002"'),
    items: z.array(itemSchema).min(1),
    cliente: clienteSchema,
    condicionVenta: z.enum(['contado', 'credito']).default('contado'),
    moneda: z.string().length(3).default('PYG'),
    numero: z.number().int().min(1).max(9999999).optional()
      .describe('Número explícito (modo numeración-del-ERP). Omitir para numeración automática.'),
  },
  async (args) => {
    try {
      const total = args.items.reduce((s, i) => s + i.cantidad * i.precioUnitario, 0);
      const body = {
        tipoDocumento: 1,
        establecimiento: args.establecimiento,
        punto: args.punto,
        ...(args.numero != null ? { numero: String(args.numero) } : {}),
        tipoEmision: 1,
        tipoTransaccion: 1,
        tipoImpuesto: 1,
        moneda: args.moneda,
        cliente: buildCliente(args.cliente),
        factura: { presencia: 1 },
        condicion:
          args.condicionVenta === 'contado'
            ? { tipo: 1, entregas: [{ tipo: 1, monto: String(total), moneda: args.moneda, cambio: 0 }] }
            : { tipo: 2, credito: { tipo: 1, plazo: '30 días' } },
        items: buildItems(args.items),
      };
      const r = await api('POST', `/tenants/${tenantOf(args)}/de`, body);
      return ok(resumen(r));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'emitir_nota_credito',
  'Emite una NOTA DE CRÉDITO electrónica contra una factura ya aprobada (devoluciones/anulaciones comerciales). ' +
    'Documento fiscal REAL en producción. SIFEN exige que la factura original tenga receptor IDENTIFICADO ' +
    '(RUC o CI) — una NC contra factura a consumidor final innominado será rechazada (código 1331).',
  {
    tenant_id: tenantIdSchema,
    cdcFacturaAsociada: z.string().length(44).describe('CDC (44 dígitos) de la factura que se acredita'),
    establecimiento: z.string().regex(/^\d{1,3}$/),
    punto: z.string().regex(/^\d{1,3}$/),
    items: z.array(itemSchema).min(1).describe('Ítems que se devuelven/acreditan'),
    cliente: clienteSchema.describe('Mismo receptor de la factura original (identificado)'),
    motivo: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8)])
      .default(2)
      .describe('1=Devolución y ajuste, 2=Devolución, 3=Descuento, 4=Bonificación, 5=Crédito incobrable, 6=Recupero costo, 7=Recupero gasto, 8=Ajuste precio'),
  },
  async (args) => {
    try {
      const body = {
        tipoDocumento: 5,
        establecimiento: args.establecimiento,
        punto: args.punto,
        tipoEmision: 1,
        tipoTransaccion: 1,
        tipoImpuesto: 1,
        moneda: 'PYG',
        notaCreditoDebito: { motivo: args.motivo },
        documentoAsociado: { formato: 1, cdc: args.cdcFacturaAsociada },
        cliente: buildCliente(args.cliente),
        items: buildItems(args.items),
      };
      const r = await api('POST', `/tenants/${tenantOf(args)}/de`, body);
      return ok(resumen(r));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'cancelar_documento',
  'ANULA un documento electrónico aprobado mediante el evento de cancelación de SIFEN. ' +
    'Irreversible y con efecto fiscal real. Ventana legal: 48 horas desde la emisión. ' +
    'Solo documentos en estado "aprobado" son cancelables.',
  {
    tenant_id: tenantIdSchema,
    cdc: z.string().length(44),
    motivo: z.string().min(10).max(500).describe('Motivo de la anulación (10-500 caracteres)'),
  },
  async (args) => {
    try {
      const r = await api('POST', `/tenants/${tenantOf(args)}/eventos/cancelacion`, {
        cdc: args.cdc,
        motivo: args.motivo,
      });
      return ok(r);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'consultar_documento',
  'Consulta el detalle y estado actual de un documento por su CDC (incluye respuesta de SIFEN, ' +
    'links frescos a XML y KUDE PDF, y si está cancelado).',
  { tenant_id: tenantIdSchema, cdc: z.string().length(44) },
  async (args) => {
    try {
      return ok(await api('GET', `/tenants/${tenantOf(args)}/de/${args.cdc}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'listar_documentos',
  'Lista los documentos electrónicos emitidos por el tenant (más recientes primero).',
  {
    tenant_id: tenantIdSchema,
    limit: z.number().int().min(1).max(100).default(20),
    estado: z.enum(['pendiente', 'aprobado', 'rechazado', 'error']).optional(),
  },
  async (args) => {
    try {
      const qs = new URLSearchParams({ limit: String(args.limit) });
      if (args.estado) qs.set('estado', args.estado);
      return ok(await api('GET', `/tenants/${tenantOf(args)}/de?${qs}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'estado_tenant',
  'Verifica si el tenant está listo para emitir (readiness): cert vigente, CSC, numeración, RUC válido. ' +
    'Usar antes de la primera emisión o para diagnosticar fallas.',
  { tenant_id: tenantIdSchema },
  async (args) => {
    try {
      return ok(await api('GET', `/tenants/${tenantOf(args)}/readiness`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'consultar_ruc',
  'Consulta un RUC en el padrón de SIFEN (razón social oficial, estado). Útil para completar ' +
    'los datos del receptor antes de emitir B2B. Requiere que el tenant tenga cert cargado.',
  { tenant_id: tenantIdSchema, ruc: z.string().min(5).max(20) },
  async (args) => {
    try {
      return ok(await api('GET', `/tenants/${tenantOf(args)}/consulta/ruc/${args.ruc}`));
    } catch (e) {
      return fail(e);
    }
  },
);

// ─────────────────────────────────────────────────────────────────
// Transporte: HTTP streamable (remoto, multi-cliente) o stdio (local)
// ─────────────────────────────────────────────────────────────────
if (HTTP_PORT) {
  // Modo stateless: transporte nuevo por request, sin sesiones — cada
  // cliente se autentica con su propio Bearer cmp_... de FE-PY.
  const httpServer = createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'fepy-mcp' }));
      return;
    }
    if (!req.url.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization;
    const apiKey = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;

    const chunks = [];
    for await (const c of req) chunks.push(c);
    let parsedBody;
    try {
      parsedBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    } catch {
      res.writeHead(400).end('invalid json');
      return;
    }

    await requestContext.run({ apiKey }, async () => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    });
  });
  httpServer.listen(HTTP_PORT, () => {
    console.error(`[fepy-mcp] HTTP en :${HTTP_PORT}/mcp — API: ${BASE} (auth por Bearer del cliente)`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[fepy-mcp] stdio conectado — API: ${BASE}${DEFAULT_TENANT ? ` — tenant default: ${DEFAULT_TENANT}` : ''}`);
}
