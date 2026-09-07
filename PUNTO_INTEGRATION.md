# Integración Punto ↔ FE-PY — estado real al 2026-09-07

Respuesta a la sesión de Punto (adapter `FePyProvider`). Datos verificados
contra SIFEN **producción** hoy.

## 1. Documentos reales emitidos (timbrado 18260177, tenant Balloon Party)

**UNA sola factura con validez fiscal:**

| Campo | Valor |
|---|---|
| Número | **001-002-0000612** |
| CDC | `01035951931001002000061212026090717070521170` |
| Monto | 500 Gs (IVA 10% incluido = 45 Gs) |
| Receptor | Consumidor final innominado ("Sin Nombre") |
| Estado | **Aprobado** — dCodRes 0260 |
| Protocolo autorización | `3549197037` |
| Lote | `4104242862567045944` |
| Fecha emisión | 2026-09-07 ~19:53 (hora PY) |

Intentos previos SIN efecto fiscal (SIFEN los rechazó, no existen como
documentos): CDC `...7705` (rechazo 1004) y CDC `...7969` (rechazo 1107).
No requieren cancelación — un DE rechazado no se registra.

**Cancelación de la 612: pendiente de decisión del owner** (es un evento
fiscal real; no la disparo por pedido de otra sesión). Si el owner aprueba,
el endpoint ya existe: `POST /v1/tenants/:id/eventos/cancelacion`
`{cdc, motivo}` — ventana de 48h desde la emisión.

**Correlativo:** el próximo número libre en `001-002` es **613** (la 612
está consumida y aprobada). El sistema actual del cliente (Factomate) emite
por `001-001` (última vista: 0000833) — no tocar ese punto de expedición.

## 2. Dónde corre FE-PY hoy

**Docker local en la laptop del owner** (`docker compose -f
api/docker-compose.yml`, API en `localhost:3001`). Nada hosteado.

Para llevarlo al server de Punto (Coolify): guía completa en
[api/DEPLOY.md](api/DEPLOY.md). Resumen de lo que falta:

- App en Coolify desde este repo (Dockerfile en `api/`, build context raíz)
- Postgres 16 + Redis 7 (recursos Coolify) + storage S3 (Spaces o MinIO)
- `MASTER_KEY_BASE64` NUEVA para prod + backup offline (si se pierde, los
  certs cifrados quedan irrecuperables — no reusar la de dev)
- `TZ=America/Asuncion` ya viene en la imagen (crítico, ver gotchas)
- `ENABLE_SIFEN=true`, gating de `/playground` pendiente (no exponer)
- Re-provisionar company/tenant/cert/CSC contra la instancia del server
  (la DB local de la laptop NO migra)

La decisión de deployar en 167.71.165.221 es del owner.

## 3. Credenciales e IDs

- **IDs: UUID v7** (string de 36 chars), NO int. Ejemplo real del tenant
  Balloon Party local: `01a07dc9-96bb-756e-a1fc-d89f0e0e2bda`. Tu migración
  debe usar columna UUID/text.
- **API key**: formato `cmp_<hex>`, va en header `authorization: Bearer`.
  La key actual es de la instancia LOCAL de la laptop — muere con el deploy.
  No se publica acá; al provisionar en el server se genera una nueva
  (`POST /v1/companies` la devuelve una sola vez) y se pasa por canal seguro.
- Flujo de provisión por tenant: crear tenant → `POST .../cert` (multipart
  `.p12` + password) → `PUT .../csc` (`{cscId, csc}`). El CSC sale del
  portal eKuatia del contribuyente.

## 4. Shape EXACTO del POST /v1/tenants/:id/de que aprobó SIFEN

Headers: `authorization: Bearer <key>`, `content-type: application/json`,
`idempotency-key: <uuid>` (recomendado).

```json
{
  "tipoDocumento": 1,
  "establecimiento": "001",
  "punto": "002",
  "tipoEmision": 1,
  "tipoTransaccion": 1,
  "tipoImpuesto": 1,
  "moneda": "PYG",
  "cliente": {
    "contribuyente": false,
    "razonSocial": "Sin Nombre",
    "nombreFantasia": "Sin Nombre",
    "tipoOperacion": 2,
    "documentoTipo": 5,
    "documentoNumero": "0",
    "direccion": "Asuncion",
    "numeroCasa": "0",
    "departamento": 1,
    "departamentoDescripcion": "CAPITAL",
    "distrito": 1,
    "distritoDescripcion": "ASUNCION (DISTRITO)",
    "ciudad": 1,
    "ciudadDescripcion": "ASUNCION (DISTRITO)",
    "pais": "PRY",
    "paisDescripcion": "Paraguay",
    "codigo": "000"
  },
  "factura": { "presencia": 1 },
  "condicion": {
    "tipo": 1,
    "entregas": [{ "tipo": 1, "monto": "500", "moneda": "PYG", "cambio": 0 }]
  },
  "items": [
    {
      "codigo": "GL-001",
      "descripcion": "Globo de latex",
      "unidadMedida": 77,
      "cantidad": 1,
      "precioUnitario": 500,
      "cambio": 0,
      "descuento": 0,
      "anticipo": 0,
      "pais": "PRY",
      "paisDescripcion": "Paraguay",
      "ivaTipo": 1,
      "ivaProporcion": 100,
      "iva": 10
    }
  ]
}
```

Notas del shape:
- `numero` NO se manda — lo asigna la numeración interna del API (secuencia
  por tenant/tipo/establecimiento/punto, `SELECT FOR UPDATE`).
- `fecha` opcional; si se omite el API pone hora paraguaya correcta. Si la
  mandás: `YYYY-MM-DDTHH:mm:ss` **en hora America/Asuncion, sin sufijo Z**.
- Cliente contribuyente real: `contribuyente: true` + `ruc` con DV +
  `tipoOperacion: 1` + `documentoTipo/documentoNumero` de CI.
- IVA 10% incluido: `ivaTipo: 1, ivaProporcion: 100, iva: 10`.
- `unidadMedida: 77` = unidad.

Respuesta (post-refactor `69d1d76`): `{txnId, cdc, estado:
"aprobado"|"rechazado"|"pendiente", numero, sifen: {codigoRespuesta,
mensaje, protocoloAutorizacion, loteNumero}, xmlUrl, kudeUrl, ...}`.

## 4b. Contrato completo de endpoints (shapes reales, no doc)

Todos los responses de error tienen la forma
`{"error": {"code": "<slug>", "message": "...", "details": [...]}}` —
422 con `details[]` para validaciones del motor xmlgen.

### POST /v1/companies (sin auth) — provisioning inicial

```json
// request
{ "name": "Punto POS", "email": "ops@punto.com.py" }
// response 201 — apiKey se devuelve UNA sola vez
{ "id": "<uuid7>", "name": "Punto POS", "apiKey": "cmp_<hex>", "createdAt": "..." }
```

### POST /v1/tenants — alta de contribuyente (JSON real que funcionó)

```json
{
  "ruc": "3595193-1",
  "razonSocial": "GONZALEZ QUEVEDO, CINTIA ESTEFANIA",
  "nombreFantasia": "BALLOON PARTY - HAPPY MOMENTS",
  "timbradoNumero": "18260177",
  "timbradoFecha": "2025-08-26",
  "tipoContribuyente": 1,
  "tipoRegimen": 8,
  "env": "prod",
  "actividadesEconomicas": [
    { "codigo": "47640", "descripcion": "Comercio al por menor de juegos y juguetes" }
  ],
  "establecimientos": [
    {
      "codigo": "001",
      "direccion": "Dr Camacho Dure 576",
      "numeroCasa": "576",
      "departamento": 1,
      "departamentoDescripcion": "CAPITAL",
      "distrito": 1,
      "distritoDescripcion": "ASUNCION (DISTRITO)",
      "ciudad": 1,
      "ciudadDescripcion": "ASUNCION (DISTRITO)",
      "telefono": "0994285744",
      "email": "cingonzalez@gmail.com",
      "denominacion": "MATRIZ"
    }
  ]
}
```

Response 201: el mismo shape + `id` (uuid7), `estado`, `createdAt`.
`PATCH /v1/tenants/:id` acepta cualquier subset de estos campos (así se
corrigió `timbradoFecha` en vivo). `tipoContribuyente`: 1=física, 2=jurídica.
`env`: `"test" | "prod"` (default test — Punto debe mandar `"prod"` explícito).

### POST /v1/tenants/:id/cert — multipart

Campos del form: **`file`** (el `.p12` binario) y **`password`** (texto).

```json
// response 201 (real)
{
  "fingerprint": "15e4b1291a04ca23906a1482305463bfaf31fd13d2ff8b9e2db585072d31301c",
  "subjectCn": "CINTIA ESTEFANIA GONZALEZ QUEVEDO",
  "subjectRuc": "3595193",
  "notBefore": "2026-02-02T17:56:00.000Z",
  "notAfter": "2027-02-02T17:56:00.000Z",
  "uploadedAt": "...", "revokedAt": null, "daysUntilExpiration": 147
}
```

Valida que el RUC del cert coincida con el del tenant (sin DV).

### PUT /v1/tenants/:id/csc

```json
// request                                  // response 200 (real)
{ "cscId": "0001", "csc": "<32 chars>" }    { "cscId": "0001", "updatedAt": "..." }
```

### POST /v1/tenants/:id/de — respuesta REAL

Request: sección 4. Response 201 con SIFEN habilitado (aprobado):

```json
{
  "txnId": "<uuid7>",
  "cdc": "01035951931001002000061212026090717070521170",
  "estado": "aprobado",
  "tipo": 1,
  "numero": "0000612",
  "establecimiento": "001",
  "punto": "002",
  "moneda": "PYG",
  "montoTotal": "500.0000",
  "fechaEmision": "2026-09-07T22:53:35.000Z",
  "xmlUrl": "<presigned S3, 15 min>",
  "kudeUrl": null,
  "signed": true,
  "sentToSifen": true,
  "cancelled": false,
  "sifen": {
    "codigoRespuesta": "0260",
    "mensaje": "Aprobado",
    "protocoloAutorizacion": "3549197037",
    "loteNumero": "4104242862567045944"
  },
  "createdAt": "..."
}
```

En rechazo: mismo shape con `"estado": "rechazado"` y `sifen.codigoRespuesta`
+ `sifen.mensaje` con el motivo textual de SIFEN (ej. real:
`{"codigoRespuesta": "1107", "mensaje": "Fecha de inicio de vigencia del timbrado incorrecta"}`).
En `"estado": "pendiente"`: lote aceptado sin veredicto aún — re-consultar
`GET /de/:cdc` (un worker lo resuelve solo).

Receptor: solo probamos la variante **consumidor final innominado** en vivo
(sección 4). Contribuyente con RUC y persona con CI están implementadas
(mismos campos del motor xmlgen: `contribuyente: true` + `ruc`, o
`documentoTipo: 1` + `documentoNumero`) pero SIN emisión real todavía.

### GET /v1/tenants/:id/de — listado

`?limit=&offset=&estado=` → `{ "data": [<item resumido: txnId, cdc, tipo,
numero, establecimiento, punto, estado, montoTotal, moneda, fechaEmision,
createdAt>], "pagination": {...} }`

### GET /v1/tenants/:id/de/:cdc — detalle

Mismo shape que la respuesta del POST (con presigned URLs frescas).
`POST /de/:cdc/consulta` re-consulta SIFEN y devuelve el mismo shape
actualizado. `GET /de/:cdc/xml` = XML crudo; `/kude` = PDF.

### POST /v1/tenants/:id/eventos/cancelacion

```json
// request — motivo 10-500 chars
{ "cdc": "<44 dígitos>", "motivo": "Anulacion por error de emision" }
// response 201
{
  "id": "<uuid7>", "cdc": "<cdc>", "tipoEvento": "cancelacion",
  "estado": "aprobado" | "rechazado" | "error",
  "sifenCodigoRespuesta": "...", "sifenMensaje": "...",
  "signed": true, "sentToSifen": true, "createdAt": "..."
}
```

Regla: solo documentos `aprobado` son cancelables (409 si no); ventana
SIFEN 48h. `GET /eventos?cdc=` lista eventos.

## 5. Gotchas del flujo real (ninguno está en la doc oficial)

1. **El servicio síncrono `recibe` está RESTRINGIDO en producción**:
   devuelve `1264 "RUC del emisor no está habilitado para utilizar este
   tipo de servicio"` aunque el RUC esté perfectamente habilitado. El canal
   real es `recibeLote` → `consultaLote`. El API ya lo hace internamente
   (commit `69d1d76`) — tu adapter no necesita saberlo, pero NO diagnostiques
   "falta habilitación" si ves 1264.
2. **Timezone**: SIFEN interpreta todas las horas como America/Asuncion.
   Firma/fecha en UTC = rechazo `1004 "fecha y hora de la firma digital es
   adelantada"`. Ya resuelto dentro del API (TZ en la imagen + fecha local).
3. **`timbradoFecha` debe ser EXACTA** la de Marangatú o rechazo `1107`.
   La de Balloon Party es **2025-08-26** (verificada en KUDE real; el dato
   "de memoria" del owner era otro y falló). Para cada tenant nuevo: sacarla
   de una factura electrónica ya emitida o de Marangatú, nunca estimarla.
4. **`razonSocial` = la del padrón**, no el nombre comercial. Balloon Party:
   `"GONZALEZ QUEVEDO, CINTIA ESTEFANIA"` (formato "APELLIDOS, NOMBRES" para
   persona física). Usar lookup del padrón antes de crear tenant.
5. **Tiempos SIFEN**: recepción del lote instantánea (0300), veredicto
   disponible en segundos (mismo segundo en nuestras pruebas). El API hace
   poll interno ~30s max; si no llega, devuelve `estado: "pendiente"` y un
   worker lo resuelve — tu adapter debe tolerar `pendiente` y re-consultar
   `GET /de/:cdc`.
6. **Rechazo**: `estado: "rechazado"` + `sifen.codigoRespuesta` +
   `sifen.mensaje` legible (ej. 1107). Validaciones del motor xmlgen salen
   como 422 con `error.details[]` antes de llegar a SIFEN.
7. **Número de lote de 19 dígitos** — excede `Number.MAX_SAFE_INTEGER`.
   Si lo persistís en Punto: string, jamás int/float.
8. **CSC obligatorio para el QR**: sin CSC no hay QR y SIFEN rechaza. Se
   generan en eKuatia y COEXISTEN (crear uno nuevo no rompe el del proveedor
   anterior del cliente).
9. **Un DE rechazado deja fila local** con ese número; el API aún no
   auto-reusa el número (fix pendiente). Si un cliente ve "duplicate key"
   tras un rechazo, es eso.
10. **Puntos de expedición**: usar un punto distinto al del sistema FE
    anterior del cliente (colisión de correlativo = rechazos en su operación
    actual). Balloon Party: Factomate usa 001-001, FE-PY usa 001-002.
