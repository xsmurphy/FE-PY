/**
 * Playground: HTML estático servido desde el mismo API para evitar CORS.
 *
 * Es una UI de pruebas rápidas — todas las llamadas van a los endpoints
 * reales del API (`/v1/...`). No hay backend propio, solo HTML + JS.
 * El estado (apiKey, tenantId, companyId) se persiste en localStorage.
 *
 * Uso:
 *   docker compose -f api/docker-compose.yml up
 *   abrir http://localhost:3000/playground
 *
 * NO exponer en producción — solo dev/staging. Gated detrás de un env var
 * ENABLE_PLAYGROUND en el futuro si hace falta.
 */
import type { FastifyInstance } from 'fastify';

const HTML = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Facturación API Playground</title>
<style>
  * { box-sizing: border-box; }
  :root {
    --bg: #0f1419;
    --panel: #1a1f26;
    --panel-2: #222831;
    --border: #2d3540;
    --text: #e5e7eb;
    --muted: #9ca3af;
    --accent: #3b82f6;
    --ok: #10b981;
    --err: #ef4444;
    --warn: #f59e0b;
  }
  body {
    margin: 0; padding: 0;
    font: 14px -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg); color: var(--text);
    min-height: 100vh;
  }
  .wrap {
    max-width: 1400px; margin: 0 auto; padding: 20px;
    display: grid; grid-template-columns: 380px 1fr; gap: 20px;
  }
  header { grid-column: 1 / -1; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  header .subtitle { color: var(--muted); font-size: 13px; }
  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 16px; margin-bottom: 16px;
  }
  .panel h2 {
    margin: 0 0 12px; font-size: 13px; text-transform: uppercase;
    letter-spacing: .8px; color: var(--muted);
    display: flex; align-items: center; gap: 8px;
  }
  .panel h2 .num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; background: var(--accent); color: white;
    border-radius: 50%; font-size: 11px; font-weight: 700;
  }
  label { display: block; margin-bottom: 10px; font-size: 12px; color: var(--muted); }
  label .req { color: var(--err); }
  label span { display: block; margin-bottom: 3px; font-weight: 500; }
  input, select, textarea {
    width: 100%; padding: 8px 10px;
    background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font: inherit;
  }
  input:focus, select:focus, textarea:focus {
    outline: none; border-color: var(--accent);
  }
  textarea { font: 12px Monaco, Consolas, monospace; min-height: 120px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  button {
    background: var(--accent); color: white; border: 0;
    padding: 9px 16px; border-radius: 6px; font: inherit; font-weight: 600;
    cursor: pointer; width: 100%;
  }
  button:hover { background: #2563eb; }
  button.secondary { background: var(--panel-2); border: 1px solid var(--border); }
  button.secondary:hover { background: #2d3540; }
  button.small { padding: 6px 12px; font-size: 12px; width: auto; display: inline-block; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .state-bar {
    background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 6px; padding: 10px 14px; font-size: 12px;
    margin-bottom: 12px; line-height: 1.8;
    word-break: break-all;
  }
  .state-bar .label { color: var(--muted); }
  .state-bar .val { color: var(--text); font-family: Monaco, monospace; }
  .state-bar .empty { color: var(--err); font-style: italic; }
  pre {
    background: #050709; border: 1px solid var(--border);
    border-radius: 6px; padding: 12px;
    overflow: auto; max-height: 60vh;
    font: 11px Monaco, Consolas, monospace; line-height: 1.5;
    white-space: pre-wrap; word-break: break-all;
    color: #e5e7eb;
  }
  .result { margin-top: 12px; }
  .result .status {
    display: inline-block; padding: 2px 10px; border-radius: 20px;
    font-size: 11px; font-weight: 600; margin-bottom: 8px;
  }
  .result .status.ok { background: #064e3b; color: var(--ok); }
  .result .status.err { background: #7f1d1d; color: var(--err); }
  .result .endpoint {
    display: inline-block; padding: 2px 10px;
    background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 4px; font: 11px Monaco, monospace;
    margin-left: 8px; color: var(--muted);
  }
  .tab-list { display: flex; gap: 4px; margin-bottom: 12px; flex-wrap: wrap; }
  .tab {
    padding: 8px 14px; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 6px 6px 0 0; cursor: pointer; font-size: 13px;
    border-bottom: none;
  }
  .tab.active { background: var(--bg); border-color: var(--accent); color: var(--accent); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .note {
    font-size: 11px; color: var(--muted); font-style: italic;
    margin-top: 6px;
  }
  .divider { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
  h3 { font-size: 13px; margin: 16px 0 8px; color: var(--muted); }
  .btn-group { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Facturación API Playground</h1>
    <div class="subtitle">Pruebas contra http://localhost:3000 — el stack debe estar corriendo en Docker</div>
  </header>

  <!-- Left column: state + step forms -->
  <div>
    <div class="panel">
      <h2>Estado actual</h2>
      <div class="state-bar" id="state">
        <div><span class="label">Company:</span> <span id="state-company" class="empty">— sin signup —</span></div>
        <div><span class="label">API key:</span> <span id="state-key" class="empty">—</span></div>
        <div><span class="label">Tenant:</span> <span id="state-tenant" class="empty">— sin tenant —</span></div>
      </div>
      <button class="secondary small" onclick="resetState()">Resetear estado local</button>
    </div>

    <div class="panel">
      <h2><span class="num">1</span>Signup de company</h2>
      <label><span>Nombre</span><input id="co-name" value="Test Co"></label>
      <label><span>Email</span><input id="co-email" type="email" value="admin@test.com"></label>
      <button onclick="signup()">Crear company</button>
    </div>

    <div class="panel">
      <h2><span class="num">2</span>Crear tenant</h2>
      <div class="row">
        <label><span>RUC <span class="req">*</span></span><input id="t-ruc" value="80069563-1"></label>
        <label><span>Timbrado</span><input id="t-timbrado" value="12558946"></label>
      </div>
      <label><span>Razón social</span><input id="t-razon" value="Test Panadería SA"></label>
      <label><span>Nombre fantasía</span><input id="t-fantasia" value="Test Panadería"></label>
      <div class="row">
        <label><span>Timbrado fecha</span><input id="t-timb-fecha" type="date" value="2024-01-01"></label>
        <label><span>Ambiente</span>
          <select id="t-env"><option value="test">test</option><option value="prod">prod</option></select>
        </label>
      </div>
      <button onclick="createTenant()">Crear tenant</button>
      <div class="note">Establecimiento, depto, distrito, ciudad, actividad → valores por defecto de Asunción (editables en el JSON del request)</div>
    </div>

    <div class="panel">
      <h2><span class="num">3</span>Upload certificado</h2>
      <label><span>Archivo .p12</span><input id="cert-file" type="file" accept=".p12,.pfx"></label>
      <label><span>Password del cert</span><input id="cert-pwd" type="password" value="test-pwd-123"></label>
      <button onclick="uploadCert()">Subir certificado</button>
      <div class="note">El RUC del cert debe coincidir con el del tenant. Formato PKCS#12.</div>
    </div>

    <div class="panel">
      <h2><span class="num">4</span>CSC (opcional)</h2>
      <div class="row">
        <label><span>cscId</span><input id="csc-id" value="1"></label>
      </div>
      <label><span>CSC</span><input id="csc-val" value="ABCD1234EFGH5678IJKL9012MNOP3456"></label>
      <button onclick="setCsc()">Guardar CSC</button>
    </div>
  </div>

  <!-- Right column: emit + results -->
  <div>
    <div class="panel">
      <h2><span class="num">5</span>Emitir documento</h2>
      <div class="tab-list">
        <div class="tab active" onclick="tab('factura')">Factura</div>
        <div class="tab" onclick="tab('nc')">Nota Crédito</div>
        <div class="tab" onclick="tab('events')">Eventos</div>
        <div class="tab" onclick="tab('list')">Listar DEs</div>
      </div>

      <div id="tab-factura" class="tab-content active">
        <div class="row3">
          <label><span>Establecimiento</span><input id="de-est" value="001"></label>
          <label><span>Punto</span><input id="de-punto" value="001"></label>
          <label><span>Moneda</span>
            <select id="de-moneda"><option value="PYG">PYG</option><option value="USD">USD</option></select>
          </label>
        </div>
        <h3>Cliente</h3>
        <div class="row">
          <label><span>Razón social</span><input id="cli-razon" value="Cliente de Prueba"></label>
          <label><span>RUC o CI</span><input id="cli-doc" value="2005001-1"></label>
        </div>
        <label><span>Email</span><input id="cli-email" type="email" value="cliente@test.com"></label>
        <h3>Item</h3>
        <label><span>Descripción</span><input id="item-desc" value="Producto de prueba"></label>
        <div class="row3">
          <label><span>Cantidad</span><input id="item-cant" type="number" value="1" step="0.01"></label>
          <label><span>Precio</span><input id="item-precio" type="number" value="150000" step="0.01"></label>
          <label><span>IVA %</span>
            <select id="item-iva"><option value="10" selected>10</option><option value="5">5</option><option value="0">0</option></select>
          </label>
        </div>
        <button onclick="emit(1)">Emitir Factura (tipo 1)</button>
      </div>

      <div id="tab-nc" class="tab-content">
        <label><span>CDC asociado (NC referencia a FE existente)</span><input id="nc-cdc" placeholder="44 dígitos del CDC original"></label>
        <label><span>Motivo NC</span>
          <select id="nc-motivo">
            <option value="1">1 - Devolución</option>
            <option value="2">2 - Descuento</option>
            <option value="3">3 - Bonificación</option>
            <option value="4">4 - Crédito incobrable</option>
            <option value="5">5 - Recupero de costo</option>
          </select>
        </label>
        <div class="row3">
          <label><span>Establecimiento</span><input id="nc-est" value="001"></label>
          <label><span>Punto</span><input id="nc-punto" value="001"></label>
          <label><span>Monto</span><input id="nc-monto" type="number" value="150000"></label>
        </div>
        <button onclick="emit(5)">Emitir Nota Crédito (tipo 5)</button>
      </div>

      <div id="tab-events" class="tab-content">
        <h3>Cancelación</h3>
        <label><span>CDC a cancelar</span><input id="cancel-cdc" placeholder="44 dígitos"></label>
        <label><span>Motivo (10-500 chars)</span><textarea id="cancel-motivo" rows="3">Error en el monto del documento — prueba de cancelación desde playground</textarea></label>
        <button onclick="cancelar()">Cancelar DE</button>

        <hr class="divider">

        <h3>Inutilización de rango</h3>
        <div class="row3">
          <label><span>Tipo doc</span>
            <select id="inut-tipo"><option value="1">1 FE</option><option value="5">5 NC</option><option value="6">6 ND</option><option value="7">7 NR</option></select>
          </label>
          <label><span>Desde</span><input id="inut-desde" type="number" value="1000"></label>
          <label><span>Hasta</span><input id="inut-hasta" type="number" value="1010"></label>
        </div>
        <div class="row">
          <label><span>Establecimiento</span><input id="inut-est" value="001"></label>
          <label><span>Punto</span><input id="inut-punto" value="001"></label>
        </div>
        <label><span>Motivo</span><textarea id="inut-motivo" rows="2">Inutilización por prueba desde playground</textarea></label>
        <button onclick="inutilizar()">Inutilizar rango</button>
      </div>

      <div id="tab-list" class="tab-content">
        <div class="btn-group">
          <button class="secondary" onclick="listDocs()">Listar DEs</button>
          <button class="secondary" onclick="listEventos()">Listar Eventos</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <h2>Respuesta</h2>
      <div id="result">
        <div class="note">Las respuestas de cada acción aparecen acá. Incluye status HTTP, endpoint llamado, y body formateado.</div>
      </div>
    </div>
  </div>
</div>

<script>
const API_BASE = window.location.origin;
const state = {
  get companyId() { return localStorage.getItem('fe_company_id') || null; },
  set companyId(v) { v ? localStorage.setItem('fe_company_id', v) : localStorage.removeItem('fe_company_id'); },
  get apiKey() { return localStorage.getItem('fe_api_key') || null; },
  set apiKey(v) { v ? localStorage.setItem('fe_api_key', v) : localStorage.removeItem('fe_api_key'); },
  get tenantId() { return localStorage.getItem('fe_tenant_id') || null; },
  set tenantId(v) { v ? localStorage.setItem('fe_tenant_id', v) : localStorage.removeItem('fe_tenant_id'); },
};

function renderState() {
  const co = document.getElementById('state-company');
  const k = document.getElementById('state-key');
  const t = document.getElementById('state-tenant');
  if (state.companyId) { co.textContent = state.companyId; co.className = 'val'; }
  else { co.textContent = '— sin signup —'; co.className = 'empty'; }
  if (state.apiKey) { k.textContent = state.apiKey.slice(0, 16) + '...'; k.className = 'val'; }
  else { k.textContent = '—'; k.className = 'empty'; }
  if (state.tenantId) { t.textContent = state.tenantId; t.className = 'val'; }
  else { t.textContent = '— sin tenant —'; t.className = 'empty'; }
}

function resetState() {
  state.companyId = null;
  state.apiKey = null;
  state.tenantId = null;
  renderState();
  showResult('ok', '200', 'local', 'Estado local borrado.');
}

function tab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

function showResult(type, status, endpoint, body) {
  const el = document.getElementById('result');
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  el.innerHTML =
    '<div class="result">' +
    '<span class="status ' + type + '">' + status + '</span>' +
    '<span class="endpoint">' + endpoint + '</span>' +
    '<pre>' + escapeHtml(bodyStr) + '</pre>' +
    '</div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function apiCall(method, path, body, opts = {}) {
  const headers = {};
  if (state.apiKey) headers['authorization'] = 'Bearer ' + state.apiKey;
  if (!(body instanceof FormData) && body) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  const endpoint = method + ' ' + path;
  try {
    const resp = await fetch(API_BASE + path, {
      method,
      headers,
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    showResult(resp.ok ? 'ok' : 'err', String(resp.status), endpoint, parsed);
    return { ok: resp.ok, status: resp.status, body: parsed };
  } catch (err) {
    showResult('err', 'network', endpoint, String(err));
    return { ok: false, status: 0, body: { error: String(err) } };
  }
}

function uuidKey() {
  return 'pg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

// ═══════════════════════════════════════════════════
// Acciones
// ═══════════════════════════════════════════════════

async function signup() {
  const r = await apiCall('POST', '/v1/companies', {
    name: document.getElementById('co-name').value,
    email: document.getElementById('co-email').value,
  });
  if (r.ok && r.body.apiKey) {
    state.companyId = r.body.id;
    state.apiKey = r.body.apiKey;
    renderState();
  }
}

async function createTenant() {
  const r = await apiCall('POST', '/v1/tenants', {
    ruc: document.getElementById('t-ruc').value,
    razonSocial: document.getElementById('t-razon').value,
    nombreFantasia: document.getElementById('t-fantasia').value,
    timbradoNumero: document.getElementById('t-timbrado').value,
    timbradoFecha: document.getElementById('t-timb-fecha').value,
    tipoContribuyente: 2,
    tipoRegimen: 8,
    establecimientos: [{
      codigo: '001',
      direccion: 'Calle Test 123',
      numeroCasa: '0',
      departamento: 1,
      departamentoDescripcion: 'CAPITAL',
      distrito: 1,
      distritoDescripcion: 'ASUNCION',
      ciudad: 1,
      ciudadDescripcion: 'ASUNCION',
      telefono: '021555555',
      email: 'contacto@test.com',
      denominacion: 'Casa Central',
    }],
    actividadesEconomicas: [{ codigo: '1071', descripcion: 'Prueba' }],
    env: document.getElementById('t-env').value,
  });
  if (r.ok && r.body.id) {
    state.tenantId = r.body.id;
    renderState();
  }
}

async function uploadCert() {
  if (!state.tenantId) return showResult('err', 'n/a', 'local', 'Primero creá un tenant');
  const fileInput = document.getElementById('cert-file');
  if (!fileInput.files[0]) return showResult('err', 'n/a', 'local', 'Seleccioná un archivo .p12');
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  fd.append('password', document.getElementById('cert-pwd').value);
  await apiCall('POST', '/v1/tenants/' + state.tenantId + '/cert', fd);
}

async function setCsc() {
  if (!state.tenantId) return showResult('err', 'n/a', 'local', 'Primero creá un tenant');
  await apiCall('PUT', '/v1/tenants/' + state.tenantId + '/csc', {
    cscId: document.getElementById('csc-id').value,
    csc: document.getElementById('csc-val').value,
  });
}

function buildClienteFromForm() {
  return {
    contribuyente: true,
    ruc: document.getElementById('cli-doc').value,
    razonSocial: document.getElementById('cli-razon').value,
    nombreFantasia: document.getElementById('cli-razon').value,
    tipoOperacion: 1,
    direccion: 'Calle Cliente 456',
    numeroCasa: '0',
    departamento: 1,
    departamentoDescripcion: 'CAPITAL',
    distrito: 1,
    distritoDescripcion: 'ASUNCION',
    ciudad: 1,
    ciudadDescripcion: 'ASUNCION',
    pais: 'PRY',
    paisDescripcion: 'Paraguay',
    tipoContribuyente: 1,
    documentoTipo: 1,
    documentoNumero: '1234567',
    telefono: '021555555',
    email: document.getElementById('cli-email').value,
  };
}

async function emit(tipoDocumento) {
  if (!state.tenantId) return showResult('err', 'n/a', 'local', 'Primero creá un tenant');

  let body;
  if (tipoDocumento === 1) {
    // Factura
    const precio = Number(document.getElementById('item-precio').value);
    const cant = Number(document.getElementById('item-cant').value);
    const total = String(precio * cant);
    body = {
      tipoDocumento: 1,
      establecimiento: document.getElementById('de-est').value,
      punto: document.getElementById('de-punto').value,
      tipoTransaccion: 1,
      moneda: document.getElementById('de-moneda').value,
      cliente: buildClienteFromForm(),
      usuario: { documentoTipo: 1, documentoNumero: '157264', nombre: 'Operador Test', cargo: 'Vendedor' },
      factura: { presencia: 1 },
      condicion: { tipo: 1, entregas: [{ tipo: 1, monto: total, moneda: 'PYG', cambio: 0 }] },
      items: [{
        codigo: 'P-001',
        descripcion: document.getElementById('item-desc').value,
        unidadMedida: 77,
        cantidad: cant,
        precioUnitario: precio,
        ivaTipo: 1,
        ivaBase: 100,
        iva: Number(document.getElementById('item-iva').value),
      }],
    };
  } else if (tipoDocumento === 5) {
    // Nota de crédito
    const monto = Number(document.getElementById('nc-monto').value);
    body = {
      tipoDocumento: 5,
      establecimiento: document.getElementById('nc-est').value,
      punto: document.getElementById('nc-punto').value,
      tipoTransaccion: 1,
      moneda: 'PYG',
      cliente: buildClienteFromForm(),
      usuario: { documentoTipo: 1, documentoNumero: '157264', nombre: 'Operador Test', cargo: 'Vendedor' },
      notaCreditoDebito: { motivo: Number(document.getElementById('nc-motivo').value) },
      condicion: { tipo: 1, entregas: [{ tipo: 1, monto: String(monto), moneda: 'PYG', cambio: 0 }] },
      items: [{
        codigo: 'NC-001',
        descripcion: 'Nota de crédito',
        unidadMedida: 77,
        cantidad: 1,
        precioUnitario: monto,
        ivaTipo: 1,
        ivaBase: 100,
        iva: 10,
      }],
      documentoAsociado: {
        formato: 1,
        cdc: document.getElementById('nc-cdc').value || '00000000000000000000000000000000000000000000',
        tipo: 1,
      },
    };
  }

  await apiCall('POST', '/v1/tenants/' + state.tenantId + '/de', body, { idempotencyKey: uuidKey() });
}

async function cancelar() {
  if (!state.tenantId) return showResult('err', 'n/a', 'local', 'Primero creá un tenant');
  await apiCall('POST', '/v1/tenants/' + state.tenantId + '/eventos/cancelacion', {
    cdc: document.getElementById('cancel-cdc').value,
    motivo: document.getElementById('cancel-motivo').value,
  }, { idempotencyKey: uuidKey() });
}

async function inutilizar() {
  if (!state.tenantId) return showResult('err', 'n/a', 'local', 'Primero creá un tenant');
  await apiCall('POST', '/v1/tenants/' + state.tenantId + '/eventos/inutilizacion', {
    tipoDocumento: Number(document.getElementById('inut-tipo').value),
    establecimiento: document.getElementById('inut-est').value,
    punto: document.getElementById('inut-punto').value,
    desde: Number(document.getElementById('inut-desde').value),
    hasta: Number(document.getElementById('inut-hasta').value),
    motivo: document.getElementById('inut-motivo').value,
  }, { idempotencyKey: uuidKey() });
}

async function listDocs() {
  if (!state.tenantId) return showResult('err', 'n/a', 'local', 'Primero creá un tenant');
  await apiCall('GET', '/v1/tenants/' + state.tenantId + '/de');
}

async function listEventos() {
  if (!state.tenantId) return showResult('err', 'n/a', 'local', 'Primero creá un tenant');
  await apiCall('GET', '/v1/tenants/' + state.tenantId + '/eventos');
}

renderState();
</script>
</body>
</html>`;

export const registerPlayground = (app: FastifyInstance): void => {
  app.get('/playground', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').send(HTML);
  });
};
