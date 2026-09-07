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
