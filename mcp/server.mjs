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
const DEFAULT_EST = process.env.FEPY_ESTABLECIMIENTO;
const DEFAULT_PUNTO = process.env.FEPY_PUNTO;
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

const fmtGs = (n) => new Intl.NumberFormat('es-PY').format(n);

/** Dígito verificador del RUC paraguayo (módulo 11) — mismo algoritmo del API. */
const dvRuc = (base) => {
  let k = 2, total = 0;
  for (let i = base.length - 1; i >= 0; i--) {
    if (k > 11) k = 2;
    total += Number(base[i]) * k++;
  }
  const resto = total % 11;
  return resto > 1 ? 11 - resto : 0;
};

const estPunto = (args) => {
  const establecimiento = args.establecimiento ?? DEFAULT_EST;
  const punto = args.punto ?? DEFAULT_PUNTO;
  if (!establecimiento || !punto) {
    throw new Error('Faltan establecimiento/punto (o configurá FEPY_ESTABLECIMIENTO y FEPY_PUNTO)');
  }
  return { establecimiento, punto };
};

/** Resuelve el receptor contra el padrón cuando hay RUC. */
const resolverReceptor = async (tenantId, cliente) => {
  if (cliente?.ruc) {
    const r = await api('GET', `/tenants/${tenantId}/consulta/ruc/${cliente.ruc.split('-')[0]}`);
    // la respuesta cruda de SIFEN trae la razón social — buscarla en el árbol
    const raw = JSON.stringify(r);
    const nombre = /"(?:x?dRazCons|razonSocial|name)"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
    return {
      tipo: 'RUC',
      documento: cliente.ruc,
      nombre: nombre ?? cliente.razonSocial ?? '(no se pudo resolver del padrón — pedir al usuario)',
      cliente: { ruc: cliente.ruc, razonSocial: nombre ?? cliente.razonSocial },
    };
  }
  if (cliente?.ci) {
    // En Paraguay el RUC de persona física = cédula + DV: consultamos el
    // padrón. Si la persona tiene RUC activo, la factura SALE CON RUC
    // automáticamente (crédito fiscal para el cliente, sin preguntar).
    let padron;
    try {
      const r = await api('GET', `/tenants/${tenantId}/consulta/ruc/${cliente.ci}`);
      const raw = JSON.stringify(r);
      padron = /"(?:x?dRazCons|razonSocial|name)"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
    } catch {
      // sin RUC en el padrón o consulta no disponible — seguimos como CI pura
    }
    if (padron) {
      const ruc = `${cliente.ci}-${dvRuc(cliente.ci)}`;
      return {
        tipo: 'RUC',
        documento: ruc,
        nombre: padron,
        nota: `La cédula ${cliente.ci} tiene RUC activo — la factura sale con RUC ${ruc} (crédito fiscal IVA para el cliente).`,
        cliente: { ruc, razonSocial: padron },
      };
    }
    return {
      tipo: 'CI',
      documento: cliente.ci,
      nombre: cliente.razonSocial ?? '(falta el nombre — pedirlo al usuario)',
      cliente: { ci: cliente.ci, razonSocial: cliente.razonSocial },
    };
  }
  return { tipo: 'Consumidor final', documento: '-', nombre: 'Sin Nombre', cliente: undefined };
};

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
const server = new McpServer(
  { name: 'fepy', version: '0.1.0' },
  {
    instructions: `Facturación electrónica legal de Paraguay (SIFEN) vía FE-PY.

ONBOARDING DE UN CONTRIBUYENTE NUEVO (en orden, pidiendo al usuario cada dato):
1. crear_tenant — pedir: constancia de RUC (da razón social EXACTA, actividad económica, dirección fiscal), número de timbrado electrónico y su fecha de inicio de vigencia. La fecha DEBE salir de Marangatú o de un KUDE ya emitido — NUNCA estimarla ni aceptar "de memoria" (rechazo 1107 garantizado si difiere; ya pasó en producción).
2. subir_certificado — pedir la ruta del archivo .p12 y su contraseña.
3. configurar_csc — el usuario lo genera/obtiene en eKuatia (ekuatia.set.gov.py, Perfil → CSC); generar uno nuevo NO rompe el de otro proveedor de facturación.
4. configurar_numeracion — SOLO si el cliente migra con correlativo avanzado (preguntá el último número emitido en su punto de expedición). Usar un punto de expedición DISTINTO al de su sistema anterior si sigue activo (colisión de numeración = rechazos en su operación).
5. estado_tenant — repetir hasta ready=true; mostrar los checks al usuario.
6. Primera emisión: factura mínima real (ej. 500 Gs) con el flujo de vista previa de abajo — es la única forma de validar timbradoFecha y habilitación del RUC contra SIFEN.

FLUJO OBLIGATORIO PARA EMITIR (ejemplo: el usuario dice "hacé factura al RUC 7659394-0 por 500000 concepto: Hs de desarrollo web"):
1. Armá los ítems desde el pedido (descripcion="Hs de desarrollo web", cantidad=1, precioUnitario=500000, iva=10 salvo que digan otra cosa).
2. Llamá previsualizar_factura — resuelve la razón social real del padrón y calcula el total. Si devuelve "(no se pudo resolver...)" o "(falta el nombre...)", pedile el dato al usuario antes de seguir.
3. Mostrá al usuario el bloque "Vista Previa" TAL CUAL lo devuelve la tool y esperá su confirmación explícita ("sí", "confirmo", "dale"). PROHIBIDO llamar emitir_factura sin esa confirmación en la conversación.
4. Confirmado → emitir_factura con los argumentosParaEmitir exactos de la previsualización. Resultado:
   - "aprobado" → la respuesta incluye el KUDE en PDF: entregáselo al usuario, junto con CDC y número.
   - "rechazado" → NO se emitió nada (sin efecto fiscal); mostrá sifen.mensaje, corregí y volvé al paso 2.
   - "pendiente" → SIFEN aún procesa; re-consultá con consultar_documento en ~1 min.
5. Devoluciones/correcciones sobre una factura aprobada → emitir_nota_credito (mismo receptor, identificado — una factura innominada no acepta NC). Anulación total dentro de las 48h → cancelar_documento (también requiere confirmación explícita del usuario).
6. Si algo falla al arrancar, diagnosticá con estado_tenant (cert/CSC/numeración).

REGLAS:
- Nunca inventes RUC, razón social ni precios: pedilos al usuario o verificalos con consultar_ruc.
- Montos en guaraníes (PYG) sin decimales; el IVA va incluido en el precio unitario.
- Ante cualquier error 4xx el mensaje del API dice exactamente qué corregir — mostralo al usuario.`,
  },
);

// ─────────────────────────────────────────────────────────────────
// Onboarding de tenants (alta completa desde el agente)
// ─────────────────────────────────────────────────────────────────
server.tool(
  'crear_tenant',
  'Da de alta un CONTRIBUYENTE EMISOR (tenant) nuevo en FE-PY. Paso 1 del onboarding. ' +
    'El RUC puede ir sin dígito verificador (se calcula). CRÍTICO: timbradoFecha debe ser ' +
    'EXACTAMENTE la fecha de inicio de vigencia que figura en Marangatú o en un KUDE ya emitido ' +
    '— NUNCA estimarla (SIFEN rechaza con 1107 si difiere). razonSocial: la del padrón/constancia ' +
    'de RUC (formato "APELLIDOS, NOMBRES" para persona física), no el nombre comercial.',
  {
    ruc: z.string().describe('RUC, con o sin DV (ej "3595193" o "3595193-1")'),
    razonSocial: z.string().describe('Razón social EXACTA del padrón/constancia'),
    nombreFantasia: z.string().optional().describe('Nombre comercial'),
    timbradoNumero: z.string(),
    timbradoFecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inicio de vigencia EXACTO (YYYY-MM-DD)'),
    tipoContribuyente: z.union([z.literal(1), z.literal(2)]).describe('1=persona física, 2=jurídica'),
    actividadCodigo: z.string().describe('Código de actividad económica (constancia de RUC)'),
    actividadDescripcion: z.string(),
    establecimiento: z.string().regex(/^\d{1,3}$/).default('001'),
    direccion: z.string().describe('Dirección fiscal (constancia de RUC)'),
    numeroCasa: z.string().default('0'),
    departamento: z.number().int().default(1).describe('Código SIFEN (1=CAPITAL)'),
    departamentoDescripcion: z.string().default('CAPITAL'),
    distrito: z.number().int().default(1),
    distritoDescripcion: z.string().default('ASUNCION (DISTRITO)'),
    ciudad: z.number().int().default(1),
    ciudadDescripcion: z.string().default('ASUNCION (DISTRITO)'),
    telefono: z.string().optional(),
    email: z.string().email().optional(),
  },
  async (args) => {
    try {
      const body = {
        ruc: args.ruc,
        razonSocial: args.razonSocial,
        nombreFantasia: args.nombreFantasia ?? args.razonSocial,
        timbradoNumero: args.timbradoNumero,
        timbradoFecha: args.timbradoFecha,
        tipoContribuyente: args.tipoContribuyente,
        tipoRegimen: 8,
        env: 'prod',
        actividadesEconomicas: [{ codigo: args.actividadCodigo, descripcion: args.actividadDescripcion }],
        establecimientos: [
          {
            codigo: args.establecimiento,
            direccion: args.direccion,
            numeroCasa: args.numeroCasa,
            departamento: args.departamento,
            departamentoDescripcion: args.departamentoDescripcion,
            distrito: args.distrito,
            distritoDescripcion: args.distritoDescripcion,
            ciudad: args.ciudad,
            ciudadDescripcion: args.ciudadDescripcion,
            ...(args.telefono ? { telefono: args.telefono } : {}),
            ...(args.email ? { email: args.email } : {}),
            denominacion: 'MATRIZ',
          },
        ],
      };
      const r = await api('POST', '/tenants', body);
      return ok({
        tenantId: r.id,
        ruc: r.ruc,
        razonSocial: r.razonSocial,
        env: r.env,
        siguientePaso: 'subir_certificado con el .p12 del contribuyente',
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'subir_certificado',
  'Sube el certificado digital .p12 del contribuyente (paso 2 del onboarding). El archivo debe ' +
    'estar en el disco local; la contraseña la provee el usuario. FE-PY valida vigencia, password ' +
    'y que el RUC del certificado coincida con el del tenant; se guarda cifrado (envelope encryption).',
  {
    tenant_id: tenantIdSchema,
    p12Path: z.string().describe('Ruta local absoluta al archivo .p12'),
    password: z.string().describe('Contraseña del certificado'),
  },
  async (args) => {
    try {
      const { readFileSync } = await import('node:fs');
      const buf = readFileSync(args.p12Path);
      const form = new FormData();
      form.append('file', new Blob([buf]), 'cert.p12');
      form.append('password', args.password);
      const apiKey = currentApiKey();
      const res = await fetch(`${BASE}/v1/tenants/${tenantOf(args)}/cert`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`FE-PY ${res.status}: ${json?.error?.message ?? JSON.stringify(json)}`);
      return ok({ ...json, siguientePaso: 'configurar_csc con el CSC del portal eKuatia' });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'configurar_csc',
  'Configura el Código de Seguridad del Contribuyente (paso 3 del onboarding). El CSC sale del ' +
    'portal eKuatia del contribuyente (32 caracteres alfanuméricos) — obligatorio para el QR; ' +
    'sin él SIFEN rechaza toda emisión.',
  {
    tenant_id: tenantIdSchema,
    cscId: z.string().min(1).max(10).describe('Id del CSC, típicamente "0001"'),
    csc: z.string().regex(/^[A-Za-z0-9]{32}$/).describe('CSC de 32 caracteres'),
  },
  async (args) => {
    try {
      const r = await api('PUT', `/tenants/${tenantOf(args)}/csc`, { cscId: args.cscId, csc: args.csc });
      return ok({ ...r, siguientePaso: 'configurar_numeracion si migra correlativo; si no, estado_tenant' });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'configurar_numeracion',
  'Setea el correlativo inicial (paso 4, SOLO para clientes que migran de otro sistema de ' +
    'facturación con numeración avanzada). ultimoNumero = último YA usado; la próxima emisión ' +
    'sale con +1. Cliente nuevo sin historia: NO llamar esta tool (arranca en 1 solo).',
  {
    tenant_id: tenantIdSchema,
    tipoDocumento: z.number().int().min(1).max(8).default(1).describe('1=FE, 5=NC'),
    establecimiento: z.string().regex(/^\d{1,3}$/),
    punto: z.string().regex(/^\d{1,3}$/),
    ultimoNumero: z.number().int().min(0).max(9999999),
  },
  async (args) => {
    try {
      const r = await api('PUT', `/tenants/${tenantOf(args)}/numeracion`, {
        tipoDocumento: args.tipoDocumento,
        establecimiento: args.establecimiento,
        punto: args.punto,
        ultimoNumero: args.ultimoNumero,
      });
      return ok({ ...r, siguientePaso: 'estado_tenant para verificar readiness' });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'previsualizar_factura',
  'PASO OBLIGATORIO antes de emitir: arma la vista previa de la factura resolviendo el receptor ' +
    'contra el padrón de SIFEN (si hay RUC) y calculando totales. Mostrá el bloque "Vista Previa" ' +
    'devuelto TAL CUAL al usuario y preguntale "¿Confirmás emitir la factura?". Solo si el usuario ' +
    'confirma explícitamente, llamá emitir_factura con los MISMOS argumentos.',
  {
    tenant_id: tenantIdSchema,
    establecimiento: z.string().regex(/^\d{1,3}$/).optional().describe('Default: env FEPY_ESTABLECIMIENTO'),
    punto: z.string().regex(/^\d{1,3}$/).optional().describe('Default: env FEPY_PUNTO'),
    items: z.array(itemSchema).min(1),
    cliente: clienteSchema,
    condicionVenta: z.enum(['contado', 'credito']).default('contado'),
  },
  async (args) => {
    try {
      const tenantId = tenantOf(args);
      const { establecimiento, punto } = estPunto(args);
      const receptor = await resolverReceptor(tenantId, args.cliente);
      const total = args.items.reduce((s, i) => s + i.cantidad * i.precioUnitario, 0);
      const lineas = args.items
        .map((i, n) => `Concepto: ${n + 1} - ${i.descripcion} x${i.cantidad} a ${fmtGs(i.precioUnitario)} gs.`)
        .join('\n');
      const preview = [
        'Vista Previa',
        '-------------------------',
        `${receptor.tipo}: ${receptor.documento}`,
        `Cliente: ${receptor.nombre}`,
        lineas,
        `Punto de emisión: ${establecimiento}-${punto} — Condición: ${args.condicionVenta}`,
        '-------------------------',
        `Total: ${fmtGs(total)} gs. (IVA incluido)`,
        '',
        '¿Confirmás emitir la factura?',
      ].join('\n');
      return ok({
        preview,
        ...(receptor.nota ? { nota: receptor.nota } : {}),
        // argumentos EXACTOS para emitir_factura tras la confirmación
        argumentosParaEmitir: {
          tenant_id: args.tenant_id,
          establecimiento,
          punto,
          items: args.items,
          cliente: receptor.cliente,
          condicionVenta: args.condicionVenta,
        },
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'emitir_factura',
  'Emite una FACTURA ELECTRÓNICA legal en SIFEN (Paraguay). Llamar SOLO después de que ' +
    'previsualizar_factura fue mostrada al usuario y el usuario CONFIRMÓ explícitamente — ' +
    'usar los argumentosParaEmitir que devolvió la previsualización. Genera un documento fiscal ' +
    'REAL. Si el estado es "aprobado", devuelve además el KUDE (PDF) para entregar al cliente.',
  {
    tenant_id: tenantIdSchema,
    establecimiento: z.string().regex(/^\d{1,3}$/).optional().describe('Default: env FEPY_ESTABLECIMIENTO'),
    punto: z.string().regex(/^\d{1,3}$/).optional().describe('Default: env FEPY_PUNTO'),
    items: z.array(itemSchema).min(1),
    cliente: clienteSchema,
    condicionVenta: z.enum(['contado', 'credito']).default('contado'),
    moneda: z.string().length(3).default('PYG'),
    numero: z.number().int().min(1).max(9999999).optional()
      .describe('Número explícito (modo numeración-del-ERP). Omitir para numeración automática.'),
  },
  async (args) => {
    try {
      const { establecimiento, punto } = estPunto(args);
      const total = args.items.reduce((s, i) => s + i.cantidad * i.precioUnitario, 0);
      const body = {
        tipoDocumento: 1,
        establecimiento,
        punto,
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
      const content = [{ type: 'text', text: JSON.stringify(resumen(r), null, 2) }];
      // KUDE embebido al aprobar — el agente lo entrega al usuario como PDF
      if (r.estado === 'aprobado' && r.kudeUrl) {
        try {
          const pdf = await fetch(r.kudeUrl);
          if (pdf.ok) {
            const blob = Buffer.from(await pdf.arrayBuffer()).toString('base64');
            content.push({
              type: 'resource',
              resource: {
                uri: `fepy://kude/${r.cdc}.pdf`,
                mimeType: 'application/pdf',
                blob,
              },
            });
          }
        } catch {
          // el link kudeUrl del resumen sigue disponible
        }
      }
      return { content };
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
