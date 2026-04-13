const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const xmlgen = require('./dist').default;
const xmlsign = require('facturacionelectronicapy-xmlsign').default;
const qrgen = require('facturacionelectronicapy-qrgen').default;
const setapi = require('facturacionelectronicapy-setapi').default;

const PORT = 3100;
const SCHEMA_UNSIGNED = path.join(__dirname, 'xsd-unsigned', 'siRecepDE_v150.xsd');
const SCHEMA_STRICT = path.join(__dirname, 'xsd', 'siRecepDE_v150.xsd');

// ---- env loader (minimal, no deps) ----
const loadEnv = () => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
};
loadEnv();

const getCfg = () => ({
  certPath: (process.env.SIFEN_CERT_PATH || '').trim(),
  certPassword: (process.env.SIFEN_CERT_PASSWORD || '').trim(),
  cscId: (process.env.SIFEN_CSC_ID || '').trim(),
  csc: (process.env.SIFEN_CSC || '').trim(),
  env: (process.env.SIFEN_ENV || 'test').trim(),
});
const hasCert = (c) => !!(c.certPath && fs.existsSync(c.certPath) && c.certPassword);
const hasCsc = (c) => !!(c.cscId && c.csc);

// ---- defaults ----
const defaultParams = {
  version: 150,
  ruc: '80069563-1',
  razonSocial: 'DE generado en ambiente de prueba - sin valor comercial ni fiscal',
  nombreFantasia: 'TIPS S.A. TECNOLOGIA Y SERVICIOS',
  actividadesEconomicas: [{ codigo: '1254', descripcion: 'Desarrollo de Software' }],
  timbradoNumero: '12558946',
  timbradoFecha: '2022-08-25',
  tipoContribuyente: 2,
  tipoRegimen: 8,
  establecimientos: [{
    codigo: '001',
    direccion: 'Barrio Carolina',
    numeroCasa: '0',
    complementoDireccion1: 'Entre calle 2',
    complementoDireccion2: 'y Calle 7',
    departamento: 11,
    departamentoDescripcion: 'ALTO PARANA',
    distrito: 145,
    distritoDescripcion: 'CIUDAD DEL ESTE',
    ciudad: 3432,
    ciudadDescripcion: 'PUERTO PTE.STROESSNER (MUNIC)',
    telefono: '0973-527155',
    email: 'tips@tips.com.py',
    denominacion: 'Sucursal 1',
  }],
};

// ---- helpers ----
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const validateXsd = (xml, schemaPath) => new Promise((resolve) => {
  const tmp = path.join(os.tmpdir(), `xmlgen-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
  fs.writeFileSync(tmp, xml);
  execFile('xmllint', ['--noout', '--schema', schemaPath, tmp], (err, stdout, stderr) => {
    fs.unlink(tmp, () => {});
    const out = (stderr || '') + (stdout || '');
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    const errors = lines
      .filter((l) => l.includes('validity error') || l.includes('Schemas validity'))
      .map((l) => l.replace(/^.*?:\s*\d+:\s*/, '').replace(/^element\s+\w+:\s*/i, '').replace(/^Schemas validity error\s*:\s*/, ''));
    resolve({ valid: !err && errors.length === 0, errors });
  });
});

const buildData = (f) => ({
  tipoDocumento: 1,
  establecimiento: f.doc_establecimiento,
  punto: f.doc_punto,
  numero: f.doc_numero,
  codigoSeguridadAleatorio: f.doc_codseguridad,
  descripcion: f.doc_descripcion,
  observacion: 'Prueba local',
  fecha: f.doc_fecha.length === 16 ? f.doc_fecha + ':00' : f.doc_fecha,
  tipoEmision: 1,
  tipoTransaccion: 1,
  tipoImpuesto: 1,
  moneda: f.doc_moneda,
  cliente: {
    contribuyente: f.cli_tipo === 'contribuyente',
    ruc: f.cli_tipo === 'contribuyente' ? f.cli_doc : undefined,
    razonSocial: f.cli_razon,
    nombreFantasia: f.cli_razon,
    tipoOperacion: f.cli_tipo === 'contribuyente' ? 1 : 2,
    direccion: f.cli_direccion,
    numeroCasa: '0',
    departamento: 11,
    departamentoDescripcion: 'ALTO PARANA',
    distrito: 143,
    distritoDescripcion: 'DOMINGO MARTINEZ DE IRALA',
    ciudad: 3344,
    ciudadDescripcion: 'PASO ITA (INDIGENA)',
    pais: 'PRY',
    paisDescripcion: 'Paraguay',
    tipoContribuyente: 1,
    documentoTipo: 1,
    documentoNumero: f.cli_tipo === 'contribuyente' ? undefined : f.cli_doc,
    telefono: f.cli_telefono,
    email: f.cli_email,
  },
  usuario: {
    documentoTipo: 1,
    documentoNumero: '157264',
    nombre: 'Operador de Prueba',
    cargo: 'Vendedor',
  },
  factura: { presencia: 1 },
  condicion: {
    tipo: Number(f.doc_condicion),
    entregas: Number(f.doc_condicion) === 1 ? [{
      tipo: 1,
      monto: String(Number(f.item_cantidad) * Number(f.item_precio)),
      moneda: f.doc_moneda,
      cambio: 0,
    }] : undefined,
    credito: Number(f.doc_condicion) === 2 ? { tipo: 1, plazo: '30 días' } : undefined,
  },
  items: [{
    codigo: f.item_codigo,
    descripcion: f.item_descripcion,
    observacion: '',
    unidadMedida: Number(f.item_unidad),
    cantidad: Number(f.item_cantidad),
    precioUnitario: Number(f.item_precio),
    cambio: 0,
    ivaTipo: Number(f.item_iva) === 0 ? 3 : 1,
    ivaBase: 100,
    iva: Number(f.item_iva),
  }],
});

const parseForm = (body) => {
  const out = {};
  new URLSearchParams(body).forEach((v, k) => { out[k] = v; });
  return out;
};

// ---- pipeline ----
const runPipeline = async (fields) => {
  const cfg = getCfg();
  const result = {
    config: { hasCert: hasCert(cfg), hasCsc: hasCsc(cfg), env: cfg.env },
    steps: [],
  };
  const pushStep = (name, status, detail) => result.steps.push({ name, status, ...detail });

  let xml;

  // Step 1: Generar
  try {
    const params = {
      ...defaultParams,
      ruc: fields.emisor_ruc,
      razonSocial: fields.emisor_razon,
      nombreFantasia: fields.emisor_fantasia,
      timbradoNumero: fields.emisor_timbrado,
    };
    const data = buildData(fields);
    xml = await xmlgen.generateXMLDE(params, data);
    const cdc = (xml.match(/Id="(\d{44})"/) || [])[1] || null;
    pushStep('Generar XML', 'ok', { bytes: xml.length, cdc });
  } catch (e) {
    pushStep('Generar XML', 'fail', { error: e.message || String(e) });
    return { ...result, xml: null, xmlFinal: null };
  }

  // Step 2: Validar XSD (pre-firma)
  const v1 = await validateXsd(xml, SCHEMA_UNSIGNED);
  pushStep('Validar XSD (pre-firma)', v1.valid ? 'ok' : 'fail', { errors: v1.errors });
  if (!v1.valid) return { ...result, xml, xmlFinal: null };

  // Step 3: Firmar
  if (!hasCert(cfg)) {
    pushStep('Firmar XML', 'skip', { reason: 'SIFEN_CERT_PATH / SIFEN_CERT_PASSWORD no configurados en .env (o el archivo no existe)' });
    return { ...result, xml, xmlFinal: xml };
  }
  let xmlSigned;
  try {
    xmlSigned = await xmlsign.signXML(xml, cfg.certPath, cfg.certPassword);
    pushStep('Firmar XML', 'ok', { bytes: xmlSigned.length });
  } catch (e) {
    pushStep('Firmar XML', 'fail', { error: e.message || String(e) });
    return { ...result, xml, xmlFinal: null };
  }

  // Step 4: Validar XSD (estricto, post-firma)
  const v2 = await validateXsd(xmlSigned, SCHEMA_STRICT);
  pushStep('Validar XSD (estricto)', v2.valid ? 'ok' : 'fail', { errors: v2.errors });

  // Step 5: Agregar QR
  let xmlWithQr = xmlSigned;
  if (!hasCsc(cfg)) {
    pushStep('Agregar QR', 'skip', { reason: 'SIFEN_CSC_ID / SIFEN_CSC no configurados en .env' });
  } else {
    try {
      xmlWithQr = await qrgen.generateQR(xmlSigned, cfg.cscId, cfg.csc, cfg.env);
      pushStep('Agregar QR', 'ok', { bytes: xmlWithQr.length });
    } catch (e) {
      pushStep('Agregar QR', 'fail', { error: e.message || String(e) });
    }
  }

  // Step 6: Enviar a SIFEN
  try {
    const requestId = Date.now() % 1000000;
    const response = await setapi.recibe(requestId, xmlWithQr, cfg.env, cfg.certPath, cfg.certPassword);
    pushStep('Enviar a SIFEN (' + cfg.env + ')', 'ok', { response: typeof response === 'string' ? response.slice(0, 2000) : JSON.stringify(response).slice(0, 2000) });
  } catch (e) {
    pushStep('Enviar a SIFEN (' + cfg.env + ')', 'fail', { error: e.message || String(e) });
  }

  return { ...result, xml, xmlFinal: xmlWithQr };
};

// ---- HTML ----
const form = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Prueba XMLgen SIFEN - Pipeline completo</title>
<style>
  * { box-sizing: border-box; }
  body { font: 14px -apple-system, system-ui, sans-serif; margin: 0; background: #f4f5f7; color: #1a1a1a; }
  .wrap { max-width: 1500px; margin: 0 auto; padding: 20px; display: grid; grid-template-columns: 5fr 7fr; gap: 20px; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  h2 { margin: 18px 0 8px; font-size: 13px; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 4px; text-transform: uppercase; letter-spacing: .5px; }
  .panel { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  label { display: block; margin-bottom: 10px; font-size: 12px; color: #444; }
  label span { display: block; margin-bottom: 2px; font-weight: 500; }
  input, select, textarea { width: 100%; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font: inherit; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  button { background: #0066cc; color: white; border: 0; padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 12px; }
  button:hover { background: #0052a3; }
  pre { background: #1e1e1e; color: #d4d4d4; padding: 14px; border-radius: 6px; overflow: auto; font-size: 11px; line-height: 1.4; max-height: 60vh; white-space: pre-wrap; word-break: break-all; }
  .placeholder { color: #999; font-style: italic; }
  .tag { display: inline-block; background: #eef; color: #335; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-left: 8px; }
  .cfg { background: #fffbea; border: 1px solid #f0d868; padding: 10px 14px; border-radius: 6px; font-size: 12px; margin-bottom: 12px; }
  .cfg.ready { background: #eaf7ea; border-color: #7bcb7b; }
  .step { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; margin-bottom: 8px; border-radius: 6px; font-size: 13px; border-left: 4px solid #ccc; background: #f9f9f9; }
  .step.ok { border-left-color: #2ecc71; background: #f0faf0; }
  .step.fail { border-left-color: #e74c3c; background: #fef2f0; }
  .step.skip { border-left-color: #f39c12; background: #fff9ee; }
  .step .icon { font-weight: 700; font-size: 16px; min-width: 18px; }
  .step.ok .icon { color: #2ecc71; }
  .step.fail .icon { color: #e74c3c; }
  .step.skip .icon { color: #f39c12; }
  .step .body { flex: 1; }
  .step .name { font-weight: 600; }
  .step .detail { color: #666; font-size: 12px; margin-top: 2px; }
  .step ul { margin: 6px 0 0; padding-left: 18px; color: #c0392b; font-size: 11px; }
</style>
</head>
<body>
<div class="wrap">
  <form class="panel" method="post" action="/pipeline">
    <h1>Pipeline SIFEN <span class="tag">v150</span></h1>
    <p style="color:#666;margin:0 0 12px">Genera → valida XSD → firma → agrega QR → envía a SIFEN.<br>Los pasos 3-5 requieren certificado + CSC en <code>.env</code>.</p>

    <h2>Emisor</h2>
    <div class="row">
      <label><span>RUC</span><input name="emisor_ruc" value="80069563-1"></label>
      <label><span>Timbrado</span><input name="emisor_timbrado" value="12558946"></label>
    </div>
    <label><span>Razón Social</span><input name="emisor_razon" value="DE generado en ambiente de prueba - sin valor comercial ni fiscal"></label>
    <label><span>Nombre Fantasía</span><input name="emisor_fantasia" value="TIPS S.A. TECNOLOGIA Y SERVICIOS"></label>

    <h2>Documento</h2>
    <div class="row3">
      <label><span>Establecimiento</span><input name="doc_establecimiento" value="001"></label>
      <label><span>Punto</span><input name="doc_punto" value="001"></label>
      <label><span>Número</span><input name="doc_numero" value="0000001"></label>
    </div>
    <div class="row">
      <label><span>Fecha emisión</span><input name="doc_fecha" type="datetime-local" value="2025-01-15T10:30"></label>
      <label><span>Código seguridad</span><input name="doc_codseguridad" value="298398"></label>
    </div>
    <div class="row">
      <label><span>Moneda</span>
        <select name="doc_moneda">
          <option value="PYG" selected>PYG</option>
          <option value="USD">USD</option>
        </select>
      </label>
      <label><span>Condición</span>
        <select name="doc_condicion">
          <option value="1" selected>Contado</option>
          <option value="2">Crédito</option>
        </select>
      </label>
    </div>
    <label><span>Descripción (dInfoFisc)</span><input name="doc_descripcion" value="Factura de prueba"></label>

    <h2>Cliente</h2>
    <div class="row">
      <label><span>Tipo</span>
        <select name="cli_tipo">
          <option value="contribuyente" selected>Contribuyente (RUC)</option>
          <option value="noContribuyente">No contribuyente (CI)</option>
        </select>
      </label>
      <label><span>Documento / RUC</span><input name="cli_doc" value="2005001-1"></label>
    </div>
    <label><span>Razón Social / Nombre</span><input name="cli_razon" value="Marcos Adrian Jara Rodriguez"></label>
    <div class="row">
      <label><span>Teléfono</span><input name="cli_telefono" value="021-555555"></label>
      <label><span>Email</span><input name="cli_email" value="cliente@cliente.com"></label>
    </div>
    <label><span>Dirección</span><input name="cli_direccion" value="Avda Calle Segunda y Proyectada"></label>

    <h2>Item</h2>
    <div class="row">
      <label><span>Código</span><input name="item_codigo" value="A-001"></label>
      <label><span>Unidad (77=UNI)</span><input name="item_unidad" type="number" value="77"></label>
    </div>
    <label><span>Descripción</span><input name="item_descripcion" value="Producto o Servicio de prueba"></label>
    <div class="row3">
      <label><span>Cantidad</span><input name="item_cantidad" type="number" step="0.01" value="2"></label>
      <label><span>Precio unitario</span><input name="item_precio" type="number" step="0.01" value="50000"></label>
      <label><span>IVA %</span>
        <select name="item_iva">
          <option value="0">0</option>
          <option value="5">5</option>
          <option value="10" selected>10</option>
        </select>
      </label>
    </div>

    <button type="submit">Ejecutar pipeline</button>
  </form>

  <div class="panel">
    <div id="cfg" class="cfg">Cargando config...</div>
    <h1>Resultado</h1>
    <div id="steps"></div>
    <div id="xmlbox"><p class="placeholder">Ejecutá el pipeline para ver el resultado.</p></div>
  </div>
</div>
<script>
  const ICONS = { ok: '✓', fail: '✗', skip: '○' };

  const renderCfg = (c) => {
    const cfgEl = document.getElementById('cfg');
    const parts = [];
    parts.push(c.hasCert ? '<b>✓ Certificado cargado</b>' : '<b>○ Sin certificado</b> (pasos 3-6 se saltan)');
    parts.push(c.hasCsc ? '<b>✓ CSC configurado</b>' : '<b>○ Sin CSC</b> (paso 5 se salta)');
    parts.push('Ambiente: <b>' + c.env + '</b>');
    cfgEl.innerHTML = parts.join(' &middot; ');
    cfgEl.className = 'cfg' + (c.hasCert && c.hasCsc ? ' ready' : '');
  };

  fetch('/status').then(r => r.json()).then(renderCfg);

  document.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const stepsEl = document.getElementById('steps');
    const xmlboxEl = document.getElementById('xmlbox');
    stepsEl.innerHTML = '<p class="placeholder">Ejecutando...</p>';
    xmlboxEl.innerHTML = '';

    const fd = new FormData(e.target);
    const body = new URLSearchParams(fd).toString();
    const r = await fetch('/pipeline', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json();

    if (!j.ok && j.error) {
      stepsEl.innerHTML = '<div class="step fail"><div class="icon">✗</div><div class="body"><div class="name">Error fatal</div><div class="detail">' + escapeHtml(j.error) + '</div></div></div>';
      return;
    }

    renderCfg(j.config);

    stepsEl.innerHTML = j.steps.map(s => {
      let detail = '';
      if (s.error) detail = escapeHtml(s.error);
      else if (s.reason) detail = escapeHtml(s.reason);
      else if (s.cdc) detail = 'CDC: ' + s.cdc + ' &middot; ' + s.bytes + ' bytes';
      else if (s.bytes) detail = s.bytes + ' bytes';
      else if (s.response) detail = '<pre style="max-height:160px;margin:4px 0 0">' + escapeHtml(s.response) + '</pre>';
      const errList = (s.errors && s.errors.length)
        ? '<ul>' + s.errors.map(e => '<li>' + escapeHtml(e) + '</li>').join('') + '</ul>'
        : '';
      return '<div class="step ' + s.status + '"><div class="icon">' + ICONS[s.status] + '</div><div class="body"><div class="name">' + escapeHtml(s.name) + '</div><div class="detail">' + detail + '</div>' + errList + '</div></div>';
    }).join('');

    const shown = j.xmlFinal || j.xml;
    if (shown) {
      xmlboxEl.innerHTML = '<h2>XML</h2><pre>' + escapeHtml(shown) + '</pre>';
    }
  });
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
</script>
</body>
</html>`;

// ---- server ----
http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(form);
  }
  if (req.method === 'GET' && req.url === '/status') {
    const cfg = getCfg();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ hasCert: hasCert(cfg), hasCsc: hasCsc(cfg), env: cfg.env }));
  }
  if (req.method === 'POST' && req.url === '/pipeline') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const fields = parseForm(body);
        const result = await runPipeline(fields);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => {
  const cfg = getCfg();
  console.log('Pipeline SIFEN UI:  http://localhost:' + PORT);
  console.log('  certificado:    ', hasCert(cfg) ? '✓ cargado (' + cfg.certPath + ')' : '○ no configurado');
  console.log('  CSC:            ', hasCsc(cfg) ? '✓ configurado' : '○ no configurado');
  console.log('  ambiente:       ', cfg.env);
});
