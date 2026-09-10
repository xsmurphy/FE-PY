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

**Actualización post-batería (2026-09-07 ~23:10 PY):**

| Doc | Estado final |
|---|---|
| 001-002-0000612 | Aprobada → **ANULADA** por evento (SIFEN 0600, "Evento registrado correctamente") |
| 001-002-0000613 | **VIGENTE** — aprobada directo por el pipeline integrado (0260, protocolo `3549238961`, CDC `01035951931001002000061312026090714586994762`) |

**Correlativo: el próximo número libre en `001-002` es 614.** El sistema
actual del cliente (Factomate) emite por `001-001` (última vista: 0000833)
— no tocar ese punto de expedición; corregir el BranchDocumentType de
Factomate DEV que quedó apuntando a 001-002.

Cancelación (ejercitada en vivo): respuesta 201 `{id, cdc, tipoEvento:
"cancelacion", estado: "aprobado", sifenCodigoRespuesta: "0600",
sifenMensaje: "Evento registrado correctamente", ...}` — el código de
aprobación de EVENTOS es **0600**, no 0260. Solo docs `aprobado` son
cancelables (409 si no); ventana 48h.

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
- **`numero` — dos modos** (commit `2958042`): si NO se manda, lo asigna la
  numeración interna del API (secuencia por tenant/tipo/est/punto con
  `SELECT FOR UPDATE`); si SE manda (entero 1-9999999), manda el ERP y la
  secuencia interna se sincroniza hacia arriba (mezclar modos no colisiona).
  Número ya activo en ese scope → 409; números de docs rechazados/error son
  reutilizables (índice único parcial).
- **Correlativo inicial por API** (onboarding de clientes que migran):
  `PUT /v1/tenants/:id/numeracion` con `{tipoDocumento, establecimiento,
  punto, ultimoNumero}` (próxima emisión = +1; 409 si retrocede por debajo
  del mayor número activo). `GET /v1/tenants/:id/numeracion` lista las
  secuencias con `proximoNumero`. Chau SQL manual.
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

## 6. Nota de Remisión Electrónica (tipoDocumento=7)

Documento fiscal que ampara el **TRASLADO** de mercadería, no una venta. No
lleva precios, IVA ni totales — `montoTotal` vuelve en `"0"` en la respuesta
y eso es correcto, no un bug.

Se emite por el **mismo** endpoint que la factura: `POST
/v1/tenants/:id/de` con `tipoDocumento: 7`. No hay endpoint aparte.

Diferencias explícitas con la factura (rompen si asumís el shape de la
sección 4):

- **NO lleva** `tipoTransaccion`, `moneda` ni `condicion` — si los mandás,
  el API los ignora: SIFEN no genera el bloque `gOpeCom` para el tipo 7.
- Los **ítems van sin** `precioUnitario` ni `iva` — solo código, descripción,
  unidad de medida y cantidad.

### Campos obligatorios

- `remision` (objeto):
  - `motivo` — ver tabla de motivos más abajo.
  - `motivoDescripcion` — obligatorio solo si `motivo=99` (Otro).
  - `tipoResponsable` — quién emite la remisión: 1=Emisor de la factura,
    2=Poseedor de la factura y bienes, 3=Empresa transportista,
    4=Despachante de Aduanas, 5=Agente de transporte o intermediario.
  - `kms` — kilómetros estimados del traslado, número positivo.
- `detalleTransporte` (objeto):
  - `tipo` — 1=Propio, 2=Tercero.
  - `modalidad` — 1=Terrestre, 2=Fluvial, 3=Aéreo, 4=Multimodal.
  - `tipoResponsable` — **responsable del COSTO DEL FLETE** (iRespFlete),
    NO confundir con `remision.tipoResponsable`: 1=Emisor de la factura
    electrónica, 2=Receptor de la factura electrónica, 3=Tercero,
    4=Agente intermediario del transporte, 5=Transporte propio.
  - `inicioEstimadoTranslado` / `finEstimadoTranslado` — `yyyy-MM-dd`; fin
    no puede ser anterior a inicio.
- `cliente.direccion` + `cliente.numeroCasa` — a dónde va la mercadería.

**Advertencia importante:** `detalleTransporte.tipoResponsable` (iRespFlete)
es obligatorio por el XSD oficial de SIFEN, pero el motor xmlgen que usa
FE-PY **no lo valida**. Si falta, el documento no explota acá — pasa la
generación del XML y recién revienta en la validación XSD, con un error
prácticamente ilegible para el integrador. FE-PY ahora lo valida ANTES de
generar el XML y devuelve 422 con mensaje claro (`de-validation.ts`,
`validarRemision`). Si integrás contra una versión vieja de este API sin
ese chequeo, agregalo vos del lado del adapter.

### Opcionales

- `detalleTransporte.salida` / `.entrega` — dirección, numeroCasa, ciudad
  del punto de salida/entrega (además del destino en `cliente`).
- `detalleTransporte.vehiculo` — tipo, marca, documentoTipo,
  documentoNumero, numeroMatricula.
- `detalleTransporte.transportista`.
- `detalleTransporte.condicionNegociacion` — Incoterm (FOB, CIF, EXW…),
  3 caracteres.
- `remision.fechaFactura` — `yyyy-MM-dd`.
- `remision.costoFlete`.
- `documentoAsociado`.

### Motivos de remisión (`remision.motivo`)

| Código | Motivo |
|---|---|
| 1 | Traslado por ventas |
| 2 | Traslado por consignación |
| 3 | Exportación |
| 4 | Traslado por compra |
| 5 | Importación |
| 6 | Traslado por devolución |
| 7 | Traslado entre locales de la empresa |
| 8 | Traslado de bienes por transformación |
| 9 | Traslado de bienes por reparación |
| 10 | Traslado por emisor móvil |
| 11 | Exhibición o demostración |
| 12 | Participación en ferias |
| 13 | Traslado de encomienda |
| 14 | Decomiso |
| 99 | Otro (exige `motivoDescripcion`) |

Regla: `motivo=7` (traslado entre locales de la misma empresa) exige que el
RUC del receptor (`cliente.ruc`) sea igual al RUC del emisor. FE-PY lo
valida y devuelve 422 si no coincide.

### Ejemplo curl completo

```bash
curl -X POST https://fepy.punto.la/v1/tenants/01a07dc9-96bb-756e-a1fc-d89f0e0e2bda/de \
  -H "authorization: Bearer cmp_xxxxxxxxxxxxxxxx" \
  -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{
    "tipoDocumento": 7,
    "establecimiento": "001",
    "punto": "002",
    "cliente": {
      "contribuyente": true,
      "ruc": "7659394-0",
      "razonSocial": "MURPHY CHRISTIAN",
      "nombreFantasia": "MURPHY CHRISTIAN",
      "tipoOperacion": 1,
      "direccion": "Ruta 2 km 15",
      "numeroCasa": "0",
      "ciudad": 2226,
      "pais": "PRY",
      "paisDescripcion": "Paraguay",
      "tipoContribuyente": 1,
      "documentoTipo": 1,
      "documentoNumero": "7659394",
      "telefono": "0994285744",
      "email": "cliente@example.com"
    },
    "usuario": {
      "documentoTipo": 1,
      "documentoNumero": "157264",
      "nombre": "Cintia Gonzalez",
      "cargo": "Encargada de depósito"
    },
    "remision": {
      "motivo": 1,
      "tipoResponsable": 1,
      "kms": 32
    },
    "detalleTransporte": {
      "tipo": 1,
      "modalidad": 1,
      "tipoResponsable": 1,
      "inicioEstimadoTranslado": "2026-09-10",
      "finEstimadoTranslado": "2026-09-11",
      "entrega": {
        "direccion": "Ruta 2 km 15",
        "numeroCasa": "0",
        "ciudad": 2226
      }
    },
    "items": [
      {
        "codigo": "GL-001",
        "descripcion": "Globo de latex",
        "unidadMedida": 77,
        "cantidad": 500
      }
    ]
  }'
```

Nótese `cliente` sin `distrito`/`departamento`/descripciones: alcanza con
`ciudad` (código 2226 = Encarnación), el API deriva el resto (ver sección 7).

### Estado honesto

La remisión está validada contra el XSD oficial de SIFEN con tests
automatizados (`api/test/services/remision-xml.test.ts`,
`api/test/lib/de-validation.test.ts`). **Todavía no se emitió ninguna
remisión contra SIFEN producción** — a diferencia de la factura (sección
1), esto no está probado en vivo. No lo asumas listo para producción sin
un piloto real.

## 7. Catálogo geográfico (`/v1/geo/*`)

La dirección del receptor (y la de salida/entrega de una remisión) se
informa con **códigos** de ciudad, distrito y departamento, no con
nombres. Para evitarle al integrador hardcodear las ~6.766 ciudades de
SIFEN o adivinar un código, FE-PY expone:

- `GET /v1/geo/ciudades?q=<nombre>&limit=20` — busca por nombre parcial
  (mínimo 2 caracteres), devuelve el trío ciudad/distrito/departamento con
  descripciones.
- `GET /v1/geo/ciudades/{codigo}` — resuelve un código de ciudad conocido a
  su distrito y departamento.
- `GET /v1/geo/departamentos` — los 18 departamentos del país.

Los tres requieren `authorization: Bearer <apiKey>` pero **no** scope de
tenant (son catálogo, no datos de nadie).

**Al emitir alcanza con mandar `ciudad`** en `cliente`,
`detalleTransporte.salida` o `detalleTransporte.entrega` — el API deriva
`distrito`, `departamento` y sus descripciones automáticamente si no los
mandás. Esto aplica también a la **factura**, no solo a la remisión (mismo
mecanismo, `completarUbicacion` en `api/src/lib/geo.ts`).
