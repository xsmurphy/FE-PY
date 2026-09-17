/**
 * HTML del panel de operador. Vive en su propio módulo para que admin.ts
 * quede siendo solo las queries — el mismo criterio del playground, pero
 * separado porque acá el HTML es bastante más grande.
 *
 * Sin build step, sin framework: template string servido tal cual y JS
 * vanilla. El panel es una herramienta interna de diagnóstico; meterle un
 * bundler sería agregarle infraestructura a algo que tiene que poder
 * abrirse desde cualquier máquina contra producción.
 *
 * NO contiene ningún secreto. El token lo tipea el operador en la pantalla
 * de login, se guarda en localStorage y viaja en `x-admin-token`. Si
 * cualquier fetch vuelve 401, se borra el token y se vuelve al login.
 */

export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>FE-PY — Panel de operador</title>
<style>
  * { box-sizing: border-box; }
  :root {
    --bg: #0b0e14;
    --panel: #11151d;
    --panel-2: #1a2030;
    --border: #1e2431;
    --text: #e6e9ef;
    --muted: #8b93a7;
    --accent: #4f8cff;
    --ok: #2ecc8f;
    --err: #ff5c5c;
    --warn: #ffb84d;
  }
  html, body { overflow-x: hidden; }
  body {
    margin: 0;
    font: 14px -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg); color: var(--text);
    min-height: 100vh;
  }
  a { color: var(--accent); }
  .mono { font-family: Monaco, Consolas, monospace; font-size: 12px; }

  /* ── Login ───────────────────────────────── */
  #login {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  #login .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 28px; width: 100%; max-width: 380px;
  }
  #login h1 { margin: 0 0 4px; font-size: 18px; }
  #login p { margin: 0 0 18px; color: var(--muted); font-size: 12px; }
  #login .err { color: var(--err); font-size: 12px; margin-top: 10px; min-height: 16px; }

  input, select {
    width: 100%; padding: 7px 9px; font-size: 13px;
    background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font: inherit;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  button {
    background: var(--accent); color: white; border: 0;
    padding: 9px 16px; border-radius: 6px; font: inherit; font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: #2563eb; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.secondary { background: transparent; border: 1px solid var(--border); color: var(--muted); font-weight: 500; }
  button.secondary:hover { background: var(--panel-2); color: var(--text); }
  button.wide { width: 100%; }

  /* ── App ─────────────────────────────────── */
  #app { display: none; }
  header {
    border-bottom: 1px solid var(--border); padding: 0 20px; height: 52px;
    display: flex; align-items: center; gap: 14px;
    position: sticky; top: 0; background: var(--bg); z-index: 10;
  }
  header h1 { margin: 0; font-size: 14px; white-space: nowrap; letter-spacing: .2px; }
  header h1 small { color: var(--muted); font-weight: 400; }
  header .spacer { flex: 1; }
  .counters { display: flex; gap: 4px; flex-wrap: wrap; overflow: hidden; }
  .counter {
    display: inline-flex; align-items: baseline; gap: 6px;
    padding: 4px 9px; border-radius: 6px; font-size: 11.5px; color: var(--muted);
    white-space: nowrap; background: transparent;
  }
  .counter b { font-size: 13px; color: var(--text); font-weight: 650; font-variant-numeric: tabular-nums; }
  .counter.ok b { color: var(--ok); }
  .counter.err b { color: var(--err); }
  .counter.warn b { color: var(--warn); }
  header button { padding: 5px 11px; font-size: 12px; }

  .wrap { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; padding: 16px 20px; align-items: start; }
  .wrap > * { min-width: 0; }
  @media (max-width: 980px) { .wrap { grid-template-columns: minmax(0, 1fr); } }

  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
  .panel > h2 {
    margin: 0; padding: 12px 14px; font-size: 12px; text-transform: uppercase;
    letter-spacing: .8px; color: var(--muted); border-bottom: 1px solid var(--border);
  }
  .panel-body { padding: 10px 14px; }

  .tree-company { border-bottom: 1px solid var(--border); padding: 10px 14px; }
  .tree-company:last-child { border-bottom: 0; }
  .tree-company .name { font-weight: 600; cursor: pointer; display: flex; gap: 6px; align-items: baseline; }
  .tree-company .name:hover { color: var(--accent); }
  .tree-company .meta { color: var(--muted); font-size: 11px; margin-top: 2px; word-break: break-all; }
  .tree-tenant {
    margin: 8px 0 0 10px; padding: 7px 9px; border-left: 2px solid var(--border);
    cursor: pointer; border-radius: 0 6px 6px 0;
  }
  .tree-tenant:hover { background: var(--panel-2); }
  .tree-tenant.active { background: var(--panel-2); border-left-color: var(--accent); }
  .tree-tenant .rs { font-size: 13px; }
  .tree-tenant .ruc { color: var(--muted); font-size: 11px; }
  .tree-tenant .counts { margin-top: 3px; font-size: 11px; color: var(--muted); }

  .badge {
    display: inline-block; padding: 1px 7px; border-radius: 999px;
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
    border: 1px solid var(--border); color: var(--muted);
  }
  .badge.prod { background: rgba(239,68,68,.12); color: var(--err); border-color: rgba(239,68,68,.35); }
  .badge.test { background: rgba(59,130,246,.12); color: var(--accent); border-color: rgba(59,130,246,.35); }
  .badge.suspended, .badge.deleted { background: rgba(245,158,11,.12); color: var(--warn); border-color: rgba(245,158,11,.35); }

  .estado { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .estado-aprobado { background: rgba(16,185,129,.15); color: var(--ok); }
  .estado-rechazado { background: rgba(239,68,68,.15); color: var(--err); }
  .estado-error { background: rgba(245,158,11,.18); color: var(--warn); }
  .estado-pendiente, .estado-generando, .estado-firmando, .estado-enviando {
    background: var(--panel-2); color: var(--muted);
  }

  .filters { display: grid; grid-template-columns: 1fr 1fr 2fr auto; gap: 8px; align-items: end; }
  @media (max-width: 760px) { .filters { grid-template-columns: 1fr 1fr; } }
  .filters label { font-size: 11px; color: var(--muted); display: block; }
  .filters label span { display: block; margin-bottom: 3px; }

  .scroll-x { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  th {
    text-align: left; padding: 8px 10px; color: var(--muted); font-size: 11px;
    text-transform: uppercase; letter-spacing: .5px; border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td { padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; white-space: nowrap; }
  td.trunc { max-width: 190px; overflow: hidden; text-overflow: ellipsis; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--panel-2); }
  td.num { text-align: right; white-space: nowrap; font-family: Monaco, Consolas, monospace; }
  td.mono { white-space: nowrap; }
  .truncate { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .pager { display: flex; align-items: center; gap: 10px; padding: 12px 14px; color: var(--muted); font-size: 12px; }
  .pager .spacer { flex: 1; }

  .empty { padding: 26px 14px; text-align: center; color: var(--muted); font-size: 13px; }

  /* ── Detalle ─────────────────────────────── */
  #overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6);
    z-index: 50; padding: 24px; overflow-y: auto;
  }
  #overlay.open { display: block; }
  #detail {
    max-width: 900px; margin: 0 auto; background: var(--panel);
    border: 1px solid var(--border); border-radius: 12px;
  }
  #detail .head {
    display: flex; align-items: center; gap: 12px; padding: 14px 18px;
    border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--panel);
    border-radius: 12px 12px 0 0; flex-wrap: wrap;
  }
  #detail .head h2 { margin: 0; font-size: 15px; }
  #detail .head .spacer { flex: 1; }
  #detail .body { padding: 16px 18px; }
  dl.kv { display: grid; grid-template-columns: 200px 1fr; gap: 6px 14px; margin: 0 0 18px; }
  @media (max-width: 660px) { dl.kv { grid-template-columns: 1fr; gap: 2px 0; } dl.kv dd { margin-bottom: 8px; } }
  dl.kv dt { color: var(--muted); font-size: 12px; }
  dl.kv dd { margin: 0; word-break: break-word; }
  h3.section {
    font-size: 11px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted);
    border-top: 1px solid var(--border); padding-top: 14px; margin: 18px 0 10px;
  }
  pre {
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px; overflow: auto; max-height: 340px;
    font: 12px Monaco, Consolas, monospace; margin: 0;
    white-space: pre-wrap; word-break: break-word;
  }
  .msg { background: var(--panel-2); border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; }
</style>
</head>
<body>

<div id="login">
  <div class="card">
    <h1>FE-PY — Panel de operador</h1>
    <p>Solo lectura. Ingresá el token de administración.</p>
    <input type="password" id="token-input" placeholder="ADMIN_TOKEN" autocomplete="off">
    <div class="err" id="login-err"></div>
    <button class="wide" id="login-btn" style="margin-top:10px">Entrar</button>
  </div>
</div>

<div id="app">
  <header>
    <h1>FE-PY <small>· Panel de operador</small></h1>
    <div class="counters" id="counters"></div>
    <div class="spacer"></div>
    <button class="secondary" id="reload-btn">Recargar</button>
    <button class="secondary" id="logout-btn">Salir</button>
  </header>

  <div class="wrap">
    <div class="panel">
      <h2>Companies y contribuyentes</h2>
      <div id="tree"><div class="empty">Cargando…</div></div>
    </div>

    <div>
      <div class="panel" style="margin-bottom:16px">
        <h2>Documentos</h2>
        <div class="panel-body">
          <div class="filters">
            <label><span>Estado</span>
              <select id="f-estado">
                <option value="">Todos</option>
                <option value="pendiente">pendiente</option>
                <option value="generando">generando</option>
                <option value="firmando">firmando</option>
                <option value="enviando">enviando</option>
                <option value="aprobado">aprobado</option>
                <option value="rechazado">rechazado</option>
                <option value="error">error</option>
              </select>
            </label>
            <label><span>Tipo</span>
              <select id="f-tipo">
                <option value="">Todos</option>
                <option value="1">1 — Factura</option>
                <option value="4">4 — Autofactura</option>
                <option value="5">5 — Nota de crédito</option>
                <option value="6">6 — Nota de débito</option>
                <option value="7">7 — Nota de remisión</option>
              </select>
            </label>
            <label><span>Buscar por CDC o número</span>
              <input id="f-q" placeholder="44 dígitos del CDC, o el número del documento" autocomplete="off">
            </label>
            <button id="f-apply">Filtrar</button>
          </div>
          <div id="active-filter" style="margin-top:10px;font-size:12px;color:var(--muted)"></div>
        </div>
        <div class="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Fecha</th><th>Company</th><th>Contribuyente</th><th>Tipo</th>
                <th>Número</th><th>Estado</th><th>CDC</th><th style="text-align:right">Monto</th><th>SIFEN</th>
              </tr>
            </thead>
            <tbody id="docs-body"></tbody>
          </table>
        </div>
        <div id="docs-empty"></div>
        <div class="pager">
          <button class="secondary" id="prev-btn">Anterior</button>
          <button class="secondary" id="next-btn">Siguiente</button>
          <div class="spacer"></div>
          <span id="pager-info"></span>
        </div>
      </div>

      <div class="panel">
        <h2>Últimos eventos</h2>
        <div class="scroll-x">
          <table>
            <thead>
              <tr><th>Fecha</th><th>Company</th><th>Contribuyente</th><th>Tipo</th><th>Estado</th><th>CDC</th><th>Cód. SIFEN</th></tr>
            </thead>
            <tbody id="eventos-body"></tbody>
          </table>
        </div>
        <div id="eventos-empty"></div>
      </div>
    </div>
  </div>
</div>

<div id="overlay">
  <div id="detail">
    <div class="head">
      <h2 id="detail-title">Documento</h2>
      <div class="spacer"></div>
      <button class="secondary" id="btn-kude">Ver KUDE</button>
      <button class="secondary" id="btn-xml">Ver XML</button>
      <button class="secondary" id="detail-close">Cerrar</button>
    </div>
    <div class="body" id="detail-body"></div>
  </div>
</div>

<script>
var TOKEN_KEY = 'fepy_admin_token';
var state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  companyId: '',
  tenantId: '',
  tenantLabel: '',
  limit: 50,
  offset: 0,
  total: 0,
  detail: null
};

// ── Helpers ───────────────────────────────────────────────
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function el(id) { return document.getElementById(id); }

// Formato es-PY SIN pasar por Number: los montos vienen como string decimal
// exacto desde Postgres y convertirlos a float podría alterar el valor.
// Acá se agrupa de a miles sobre el string y listo.
function fmtMonto(value, moneda) {
  if (value === null || value === undefined || value === '') return '—';
  var s = String(value);
  var neg = s.charAt(0) === '-';
  if (neg) s = s.slice(1);
  var parts = s.split('.');
  var entero = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  var dec = parts[1] ? parts[1].replace(/0+$/, '') : '';
  return (neg ? '-' : '') + entero + (dec ? ',' + dec : '') + (moneda ? ' ' + moneda : '');
}

function fmtFecha(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  var p = function (n) { return String(n).length < 2 ? '0' + n : String(n); };
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// CDC truncado al medio para la tabla: importa el arranque (tipo+RUC) y el
// final (que es lo que difiere entre documentos vecinos).
function fmtCdc(cdc) {
  if (!cdc) return '—';
  return cdc.slice(0, 8) + '…' + cdc.slice(-8);
}
var TIPOS_CORTO = { 1: 'FE', 4: 'AF', 5: 'NC', 6: 'ND', 7: 'NR' };

var TIPOS = { 1: 'Factura', 4: 'Autofactura', 5: 'Nota de crédito', 6: 'Nota de débito', 7: 'Nota de remisión' };
function fmtTipo(t) { return (TIPOS[t] || 'Tipo ' + t) + ' (' + t + ')'; }

function estadoTag(estado) {
  return '<span class="estado estado-' + esc(estado) + '">' + esc(estado) + '</span>';
}

// ── API ───────────────────────────────────────────────────
function api(path) {
  // Sin token no sale ni un request: evita la cascada de 401 cuando una
  // pantalla con varios fetches en vuelo se desloguea por el primero.
  if (!state.token) return Promise.reject(new Error('unauthorized'));
  return fetch(path, { headers: { 'x-admin-token': state.token } }).then(function (res) {
    if (res.status === 401) {
      logout('Token inválido o el panel está deshabilitado.');
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      return res.text().then(function (t) { throw new Error('HTTP ' + res.status + ' — ' + t); });
    }
    return res.json();
  });
}

function qs(params) {
  var out = [];
  for (var k in params) {
    if (params[k] !== '' && params[k] !== null && params[k] !== undefined) {
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
  }
  return out.length ? '?' + out.join('&') : '';
}

// ── Login / logout ────────────────────────────────────────
function showApp() {
  el('login').style.display = 'none';
  el('app').style.display = 'block';
}

function showLogin(message) {
  el('app').style.display = 'none';
  el('login').style.display = 'flex';
  el('login-err').textContent = message || '';
  el('token-input').value = '';
}

function logout(message) {
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  closeDetail();
  showLogin(message);
}

function login() {
  var value = el('token-input').value.trim();
  if (!value) { el('login-err').textContent = 'Ingresá el token.'; return; }
  state.token = value;
  el('login-btn').disabled = true;
  api('/v1/admin/overview').then(function (data) {
    localStorage.setItem(TOKEN_KEY, value);
    el('login-btn').disabled = false;
    showApp();
    renderOverview(data);
    loadCompanies();
    loadDocuments(true);
    loadEventos();
  }).catch(function (err) {
    el('login-btn').disabled = false;
    if (err.message !== 'unauthorized') el('login-err').textContent = err.message;
  });
}

// ── Overview ──────────────────────────────────────────────
function counter(label, value, cls) {
  return '<div class="counter ' + (cls || '') + '"><b>' + esc(value) + '</b>' + esc(label) + '</div>';
}

function renderOverview(data) {
  var d = data.documentos;
  var enProceso = d.pendiente + d.generando + d.firmando + d.enviando;
  el('counters').innerHTML =
    counter('Companies', data.companies) +
    counter('Contribuyentes', data.tenants) +
    counter('Documentos', d.total) +
    counter('Aprobados', d.aprobado, 'ok') +
    counter('Rechazados', d.rechazado, 'err') +
    counter('Errores', d.error, 'warn') +
    counter('En proceso', enProceso) +
    counter('Eventos', data.eventos);
}

function loadOverview() {
  return api('/v1/admin/overview').then(renderOverview).catch(function () {});
}

// ── Árbol de companies ────────────────────────────────────
function renderTree(companies) {
  if (!companies.length) {
    el('tree').innerHTML = '<div class="empty">No hay companies registradas.</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < companies.length; i++) {
    var c = companies[i];
    html += '<div class="tree-company">';
    html += '<div class="name" data-company="' + esc(c.id) + '">' + esc(c.name);
    if (c.status !== 'active') html += ' <span class="badge ' + esc(c.status) + '">' + esc(c.status) + '</span>';
    html += '</div>';
    html += '<div class="meta">' + esc(c.email) + ' · <span class="mono">' + esc(c.apiKeyPrefix) + '</span></div>';
    if (!c.tenants.length) {
      html += '<div class="meta" style="margin-top:6px">Sin contribuyentes.</div>';
    }
    for (var j = 0; j < c.tenants.length; j++) {
      var t = c.tenants[j];
      var active = state.tenantId === t.id ? ' active' : '';
      html += '<div class="tree-tenant' + active + '" data-tenant="' + esc(t.id) + '" data-label="' + esc(t.razonSocial) + '">';
      html += '<div class="rs">' + esc(t.razonSocial) + '</div>';
      html += '<div class="ruc">RUC ' + esc(t.ruc);
      html += ' <span class="badge ' + esc(t.env) + '">' + esc(t.env) + '</span>';
      if (t.status !== 'active') html += ' <span class="badge ' + esc(t.status) + '">' + esc(t.status) + '</span>';
      html += '</div>';
      var dd = t.documentos;
      var partes = [dd.aprobado + ' ok'];
      if (dd.rechazado) partes.push('<span style="color:var(--err)">' + dd.rechazado + ' rech</span>');
      if (dd.error) partes.push('<span style="color:var(--warn)">' + dd.error + ' err</span>');
      partes.push(dd.total + ' total');
      html += '<div class="counts">' + partes.join(' · ') + '</div></div>';
    }
    html += '</div>';
  }
  el('tree').innerHTML = html;

  var names = document.querySelectorAll('#tree .name');
  for (var a = 0; a < names.length; a++) {
    names[a].onclick = function () {
      state.companyId = this.getAttribute('data-company');
      state.tenantId = '';
      state.tenantLabel = '';
      loadDocuments(true);
      loadCompanies();
    };
  }
  var items = document.querySelectorAll('#tree .tree-tenant');
  for (var b = 0; b < items.length; b++) {
    items[b].onclick = function () {
      state.companyId = '';
      state.tenantId = this.getAttribute('data-tenant');
      state.tenantLabel = this.getAttribute('data-label');
      loadDocuments(true);
      loadCompanies();
    };
  }
}

function loadCompanies() {
  return api('/v1/admin/companies').then(function (r) { renderTree(r.data); }).catch(function () {});
}

// ── Tabla de documentos ───────────────────────────────────
function renderActiveFilter() {
  var bits = [];
  if (state.tenantId) bits.push('Contribuyente: ' + state.tenantLabel);
  if (state.companyId) bits.push('Company seleccionada');
  var html = bits.length
    ? esc(bits.join(' · ')) + ' — <a href="#" id="clear-filter">quitar filtro</a>'
    : 'Sin filtro de company/contribuyente — mostrando todas.';
  el('active-filter').innerHTML = html;
  var clear = el('clear-filter');
  if (clear) {
    clear.onclick = function (e) {
      e.preventDefault();
      state.companyId = '';
      state.tenantId = '';
      state.tenantLabel = '';
      loadDocuments(true);
      loadCompanies();
    };
  }
}

function renderDocs(r) {
  state.total = r.total;
  var rows = r.data;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var d = rows[i];
    var sifen = d.sifenCodigoRespuesta ? d.sifenCodigoRespuesta : '';
    var detalle = d.sifenMensaje || d.errorMessage || '';
    html += '<tr data-id="' + esc(d.txnId) + '">';
    html += '<td class="mono" title="' + esc(d.createdAt) + '">' + esc(fmtFecha(d.createdAt)) + '</td>';
    html += '<td class="trunc" style="max-width:110px" title="' + esc(d.companyName) + '">' + esc(d.companyName) + '</td>';
    html += '<td class="trunc" title="' + esc(d.tenantRazonSocial) + '">' + esc(d.tenantRazonSocial) + '</td>';
    html += '<td title="' + esc(fmtTipo(d.tipo)) + '">' + esc(TIPOS_CORTO[d.tipo] || d.tipo) + '</td>';
    html += '<td class="mono">' + esc(d.establecimiento + '-' + d.punto + '-' + d.numero) + '</td>';
    html += '<td>' + estadoTag(d.estado) + '</td>';
    html += '<td class="mono" title="' + esc(d.cdc || '') + '">' + esc(fmtCdc(d.cdc)) + '</td>';
    html += '<td class="num">' + esc(fmtMonto(d.montoTotal, d.moneda)) + '</td>';
    html += '<td class="truncate" title="' + esc(detalle) + '">' + esc(sifen ? sifen + ' ' + detalle : detalle) + '</td>';
    html += '</tr>';
  }
  el('docs-body').innerHTML = html;
  el('docs-empty').innerHTML = rows.length ? '' : '<div class="empty">No hay documentos para este filtro.</div>';

  var trs = document.querySelectorAll('#docs-body tr');
  for (var k = 0; k < trs.length; k++) {
    trs[k].onclick = function () { openDetail(this.getAttribute('data-id')); };
  }

  var desde = state.total === 0 ? 0 : state.offset + 1;
  var hasta = Math.min(state.offset + state.limit, state.total);
  el('pager-info').textContent = desde + '–' + hasta + ' de ' + state.total;
  el('prev-btn').disabled = state.offset === 0;
  el('next-btn').disabled = state.offset + state.limit >= state.total;
}

function loadDocuments(reset) {
  if (reset) state.offset = 0;
  renderActiveFilter();
  var params = {
    companyId: state.companyId,
    tenantId: state.tenantId,
    estado: el('f-estado').value,
    tipoDocumento: el('f-tipo').value,
    q: el('f-q').value.trim(),
    limit: state.limit,
    offset: state.offset
  };
  return api('/v1/admin/documents' + qs(params)).then(renderDocs).catch(function (err) {
    if (err.message !== 'unauthorized') {
      el('docs-empty').innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
    }
  });
}

// ── Eventos ───────────────────────────────────────────────
function loadEventos() {
  return api('/v1/admin/eventos' + qs({ limit: 25, offset: 0 })).then(function (r) {
    var html = '';
    for (var i = 0; i < r.data.length; i++) {
      var e = r.data[i];
      html += '<tr>';
      html += '<td class="mono">' + esc(fmtFecha(e.createdAt)) + '</td>';
      html += '<td>' + esc(e.companyName) + '</td>';
      html += '<td>' + esc(e.tenantRazonSocial) + '</td>';
      html += '<td>' + esc(e.tipoEvento) + '</td>';
      html += '<td>' + estadoTag(e.estado) + '</td>';
      html += '<td class="mono" title="' + esc(e.documentCdc || '') + '">' + esc(fmtCdc(e.documentCdc)) + '</td>';
      html += '<td>' + esc(e.sifenCodigoRespuesta || '—') + '</td>';
      html += '</tr>';
    }
    el('eventos-body').innerHTML = html;
    el('eventos-empty').innerHTML = r.data.length ? '' : '<div class="empty">No hay eventos registrados.</div>';
  }).catch(function () {});
}

// ── Detalle del documento ─────────────────────────────────
function kv(label, value) {
  return '<dt>' + esc(label) + '</dt><dd>' + (value === null || value === undefined || value === '' ? '—' : value) + '</dd>';
}

function openDetail(id) {
  api('/v1/admin/documents/' + encodeURIComponent(id)).then(function (d) {
    state.detail = d;
    el('detail-title').innerHTML = fmtTipo(d.tipo) + ' &nbsp; ' + estadoTag(d.estado);
    el('btn-xml').disabled = !d.xmlUrl;
    el('btn-kude').disabled = !d.kudeUrl;

    var html = '<dl class="kv">';
    html += kv('txn id', '<span class="mono">' + esc(d.txnId) + '</span>');
    html += kv('Company', esc(d.companyName));
    html += kv('Contribuyente', esc(d.tenantRazonSocial) + ' — RUC ' + esc(d.tenantRuc) +
      ' <span class="badge ' + esc(d.tenantEnv) + '">' + esc(d.tenantEnv) + '</span>');
    html += kv('Numeración', '<span class="mono">' + esc(d.establecimiento + '-' + d.punto + '-' + d.numero) + '</span>');
    html += kv('CDC', '<span class="mono">' + esc(d.cdc || '') + '</span>');
    html += kv('Monto total', esc(fmtMonto(d.montoTotal, d.moneda)));
    html += kv('Fecha de emisión', esc(fmtFecha(d.fechaEmision)));
    html += kv('Creado', esc(fmtFecha(d.createdAt)));
    html += kv('Actualizado', esc(fmtFecha(d.updatedAt)));
    html += kv('Reintentos', esc(d.retries));
    html += kv('Idempotency key', d.idempotencyKey ? '<span class="mono">' + esc(d.idempotencyKey) + '</span>' : '');
    html += kv('Código SIFEN', esc(d.sifenCodigoRespuesta || ''));
    html += kv('Protocolo autorización', esc(d.sifenProtocoloAutorizacion || ''));
    html += kv('Lote SIFEN', esc(d.sifenLoteNumero || ''));
    html += kv('QR', d.qrUrl ? '<a href="' + esc(d.qrUrl) + '" target="_blank" rel="noopener">Consulta pública eKuatia</a>' : '');
    html += kv('XML storage key', d.xmlStorageKey ? '<span class="mono">' + esc(d.xmlStorageKey) + '</span>' : '');
    html += kv('KUDE storage key', d.kudeStorageKey ? '<span class="mono">' + esc(d.kudeStorageKey) + '</span>' : '');
    html += '</dl>';

    if (d.sifenMensaje) {
      html += '<h3 class="section">Mensaje de SIFEN</h3><div class="msg">' + esc(d.sifenMensaje) + '</div>';
    }
    if (d.errorMessage) {
      html += '<h3 class="section">Error interno</h3><div class="msg">' + esc(d.errorMessage) + '</div>';
    }

    html += '<h3 class="section">Eventos de este CDC (' + d.eventos.length + ')</h3>';
    if (!d.eventos.length) {
      html += '<div class="empty">Sin eventos.</div>';
    } else {
      html += '<table><thead><tr><th>Fecha</th><th>Tipo</th><th>Estado</th><th>Error</th></tr></thead><tbody>';
      for (var i = 0; i < d.eventos.length; i++) {
        var e = d.eventos[i];
        html += '<tr style="cursor:default"><td class="mono">' + esc(fmtFecha(e.createdAt)) + '</td>';
        html += '<td>' + esc(e.tipoEvento) + '</td><td>' + estadoTag(e.estado) + '</td>';
        html += '<td>' + esc(e.errorMessage || '—') + '</td></tr>';
      }
      html += '</tbody></table>';
    }

    if (d.sifenResponseRaw) {
      html += '<h3 class="section">Respuesta cruda de SIFEN</h3><pre>' + esc(JSON.stringify(d.sifenResponseRaw, null, 2)) + '</pre>';
    }
    if (d.requestJson) {
      html += '<h3 class="section">Payload original del integrador</h3><pre>' + esc(JSON.stringify(d.requestJson, null, 2)) + '</pre>';
    }

    el('detail-body').innerHTML = html;
    el('overlay').classList.add('open');
  }).catch(function (err) {
    if (err.message !== 'unauthorized') alert(err.message);
  });
}

function closeDetail() {
  el('overlay').classList.remove('open');
  state.detail = null;
}

// ── Wiring ────────────────────────────────────────────────
el('login-btn').onclick = login;
el('token-input').onkeydown = function (e) { if (e.key === 'Enter') login(); };
el('logout-btn').onclick = function () { logout(''); };
el('reload-btn').onclick = function () {
  loadOverview(); loadCompanies(); loadDocuments(false); loadEventos();
};
el('f-apply').onclick = function () { loadDocuments(true); };
el('f-q').onkeydown = function (e) { if (e.key === 'Enter') loadDocuments(true); };
el('f-estado').onchange = function () { loadDocuments(true); };
el('f-tipo').onchange = function () { loadDocuments(true); };
el('prev-btn').onclick = function () {
  state.offset = Math.max(0, state.offset - state.limit);
  loadDocuments(false);
};
el('next-btn').onclick = function () {
  state.offset = state.offset + state.limit;
  loadDocuments(false);
};
el('detail-close').onclick = closeDetail;
el('overlay').onclick = function (e) { if (e.target === el('overlay')) closeDetail(); };
document.onkeydown = function (e) { if (e.key === 'Escape') closeDetail(); };
el('btn-xml').onclick = function () {
  if (state.detail && state.detail.xmlUrl) window.open(state.detail.xmlUrl, '_blank', 'noopener');
};
el('btn-kude').onclick = function () {
  if (state.detail && state.detail.kudeUrl) window.open(state.detail.kudeUrl, '_blank', 'noopener');
};

// Arranque: si ya hay token guardado probamos entrar directo. Si el token
// quedó viejo el primer fetch devuelve 401 y caemos al login solo.
if (state.token) {
  showApp();
  loadOverview().then(function () {
    loadCompanies();
    loadDocuments(true);
    loadEventos();
  });
} else {
  showLogin('');
}
</script>
</body>
</html>`;
