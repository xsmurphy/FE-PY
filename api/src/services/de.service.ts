/**
 * DE service: orquesta el pipeline completo de emisión.
 *
 * Pasos:
 *   1. Inicia transacción DB
 *   2. Reserva número (numeracion.service con SELECT FOR UPDATE)
 *   3. Construye `params` desde el tenant y `data` desde el body del cliente
 *   4. Genera XML con `xmlgen` (motor del repo padre)
 *   5. Valida XSD pre-firma
 *   6. Si ENABLE_SIFEN: descifra cert → firma → valida XSD estricto →
 *      genera QR (si hay CSC) → envía a SIFEN
 *   7. Sube XML final a MinIO/S3
 *   8. Inserta document row con estado final
 *   9. COMMIT
 *
 * Si cualquier paso falla: ROLLBACK → la numeración no se consume → el
 * cliente puede reintentar con idempotency key y no duplica nada.
 */
import { createRequire } from 'node:module';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, tenantCerts, type Tenant } from '../db/schema.js';
import { asignarSiguienteNumero } from './numeracion.service.js';
import { validatePreSigning, validatePostSigning } from '../lib/xsd-validator.js';
import { extractCdc, generateCodigoSeguridad } from '../lib/cdc.js';
import {
  decryptCertBundle,
  type EncryptedCertBundle,
} from './cert.service.js';
import { decryptTenantCsc } from './csc.service.js';
import { generateKudePdf } from './kude.service.js';
import { uploadObject, storageKey } from '../storage/s3.js';
import { sendDeViaLote } from './sifen-sender.js';
import { enqueueSifenRetry } from '../queue/queues.js';
import { env } from '../config/env.js';
import {
  BadRequestError,
  ValidationError,
  NotFoundError,
  SifenError,
  InternalError,
} from '../lib/errors.js';

// Los módulos hermanos son CJS — usamos createRequire para cargarlos desde ESM
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const xmlgen = require('facturacionelectronicapy-xmlgen').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const xmlsign = require('facturacionelectronicapy-xmlsign').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const qrgen = require('facturacionelectronicapy-qrgen').default;

// ═════════════════════════════════════════════════════════════════
// Input / Output types
// ═════════════════════════════════════════════════════════════════

export interface CreateDeInput {
  companyId: string;
  tenant: Tenant;
  // Body pasado por el cliente — estructura del motor xmlgen
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>;
  idempotencyKey?: string;
}

export interface CreateDeResult {
  txnId: string; // documents.id UUID
  cdc: string;
  estado: 'pendiente' | 'aprobado' | 'rechazado' | 'error';
  numero: string;
  establecimiento: string;
  punto: string;
  xmlStorageKey: string;
  sifenCodigoRespuesta?: string;
  sifenMensaje?: string;
  sifenProtocoloAutorizacion?: string;
  signed: boolean;
  sentToSifen: boolean;
}

// ═════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════

/**
 * Fecha/hora actual en hora paraguaya (America/Asuncion), formato
 * "YYYY-MM-DDTHH:mm:ss" que espera xmlgen para dFeEmiDE.
 *
 * SIFEN interpreta TODAS las horas del documento como hora local paraguaya
 * y rechaza con 1004 ("fecha y hora de la firma digital es adelantada") si
 * la firma queda en el futuro — usar toISOString() (UTC, +3h) acá causó
 * exactamente ese rechazo en producción (2026-09-07). No depende del TZ
 * del proceso: el formatter fija la zona explícitamente.
 */
const nowAsuncion = (): string =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Asuncion',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(' ', 'T');

/**
 * Construye el objeto `params` que espera `xmlgen.generateXMLDE()` desde
 * los datos persistidos del tenant.
 */
const buildParamsFromTenant = (tenant: Tenant) => ({
  version: 150,
  ruc: tenant.ruc,
  razonSocial: tenant.razonSocial,
  nombreFantasia: tenant.nombreFantasia ?? tenant.razonSocial,
  actividadesEconomicas: tenant.actividadesEconomicas,
  timbradoNumero: tenant.timbradoNumero,
  timbradoFecha:
    typeof tenant.timbradoFecha === 'string'
      ? tenant.timbradoFecha
      : (tenant.timbradoFecha as unknown as Date).toISOString().slice(0, 10),
  tipoContribuyente: tenant.tipoContribuyente,
  tipoRegimen: tenant.tipoRegimen,
  establecimientos: tenant.establecimientos,
});

/**
 * Carga el cert cifrado del tenant desde DB y lo devuelve en formato
 * EncryptedCertBundle listo para pasar a decryptCertBundle.
 */
const loadTenantCertBundle = async (tenantId: string, companyId: string): Promise<EncryptedCertBundle> => {
  const [row] = await db
    .select()
    .from(tenantCerts)
    .where(and(eq(tenantCerts.tenantId, tenantId), eq(tenantCerts.companyId, companyId)))
    .limit(1);

  if (!row) {
    throw new NotFoundError('Certificate for tenant');
  }
  if (row.revokedAt) {
    throw new BadRequestError('El certificado del tenant está revocado');
  }
  if (row.notAfter < new Date()) {
    throw new BadRequestError('El certificado del tenant está vencido');
  }

  return {
    p12: {
      ciphertext: row.encryptedP12,
      iv: row.ivP12,
      tag: row.tagP12,
    },
    password: {
      ciphertext: row.encryptedPassword,
      iv: row.ivPassword,
      tag: row.tagPassword,
    },
    dek: {
      ciphertext: row.encryptedDek,
      iv: row.ivDek,
      tag: row.tagDek,
    },
  };
};


/**
 * Firma un XML con el cert del tenant. Escribe el p12 a un tmp file con
 * perms 0600, llama xmlsign, y borra el tmp file al final.
 *
 * Limpia los buffers sensibles en el finally.
 */
const signXmlWithBundle = async (xml: string, bundle: EncryptedCertBundle): Promise<string> => {
  const decrypted = decryptCertBundle(bundle);
  const tmpPath = join(tmpdir(), `cert-${randomUUID()}.p12`);

  try {
    await writeFile(tmpPath, decrypted.p12, { mode: 0o600 });
    const xmlSigned = await xmlsign.signXML(xml, tmpPath, decrypted.password);
    if (typeof xmlSigned !== 'string') {
      throw new InternalError('xmlsign returned non-string');
    }
    return xmlSigned;
  } finally {
    decrypted.p12.fill(0);
    await unlink(tmpPath).catch(() => {});
  }
};

// ═════════════════════════════════════════════════════════════════
// Pipeline principal
// ═════════════════════════════════════════════════════════════════

export const createDeDocument = async (input: CreateDeInput): Promise<CreateDeResult> => {
  const { tenant, body, companyId } = input;
  const tipoDocumento = Number(body.tipoDocumento ?? 1);

  // Validación rápida: tipos soportados (FE, Autofactura, NC, ND, NR)
  // El motor xmlgen soporta todos — acá validamos que sea uno conocido
  if (![1, 4, 5, 6, 7].includes(tipoDocumento)) {
    throw new BadRequestError(
      `tipoDocumento=${tipoDocumento} no soportado. Válidos: 1=FE, 4=Autofactura, 5=NC, 6=ND, 7=NR`,
    );
  }

  const establecimiento = String(body.establecimiento ?? '').padStart(3, '0');
  const punto = String(body.punto ?? '').padStart(3, '0');
  if (!/^\d{3}$/.test(establecimiento) || !/^\d{3}$/.test(punto)) {
    throw new BadRequestError('establecimiento y punto deben ser 3 dígitos');
  }

  // Toda la operación de reserva+insert va en una transacción
  const result = await db.transaction(async (tx) => {
    // 1. Reservar siguiente número
    const numero = await asignarSiguienteNumero(tx as unknown as Parameters<typeof asignarSiguienteNumero>[0], {
      tenantId: tenant.id,
      tipo: tipoDocumento,
      establecimiento,
      punto,
    });

    // 2. Preparar data para xmlgen
    const codigoSeguridad = String(body.codigoSeguridadAleatorio ?? generateCodigoSeguridad()).padStart(
      9,
      '0',
    );
    const fecha = body.fecha ?? nowAsuncion();

    const dataForXmlgen = {
      ...body,
      tipoDocumento,
      establecimiento,
      punto,
      numero,
      codigoSeguridadAleatorio: codigoSeguridad,
      fecha,
    };

    // 3. Insertar document row con estado "generando"
    const [docRow] = await tx
      .insert(documents)
      .values({
        companyId,
        tenantId: tenant.id,
        cdc: null, // se llena después con el CDC de xmlgen — el UNIQUE permite múltiples NULL
        tipo: tipoDocumento,
        establecimiento,
        punto,
        numero,
        fechaEmision: new Date(fecha),
        moneda: body.moneda ?? 'PYG',
        montoTotal: String(calcularMontoTotal(body)),
        estado: 'generando',
        requestJson: body,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: documents.id });

    return { docId: docRow.id, dataForXmlgen, numero };
  });

  const { docId, dataForXmlgen, numero } = result;

  // A partir de acá trabajamos fuera de la transacción (operaciones I/O lentas)
  // Si algo falla, actualizamos el document row con estado=error
  try {
    // 4. Generar XML
    const params = buildParamsFromTenant(tenant);
    let xml: string;
    try {
      xml = await xmlgen.generateXMLDE(params, dataForXmlgen);
    } catch (xmlgenErr) {
      // El motor xmlgen tiene su propio validador de reglas de negocio.
      // Cuando lanza Error con mensaje legible ("La razon Social debe tener
      // entre 4 y 250 caracteres"), lo re-envolvemos como ValidationError (422)
      // en vez de dejarlo subir al handler de 500.
      const msg = xmlgenErr instanceof Error ? xmlgenErr.message : String(xmlgenErr);
      // Mensaje típico del motor contiene las reglas violadas separadas por ';'
      const errors = msg.split(';').map((s) => s.trim()).filter(Boolean);
      throw new ValidationError('xmlgen validation failed', errors.length > 0 ? errors : [msg]);
    }

    const cdc = extractCdc(xml);
    if (!cdc) {
      throw new InternalError('xmlgen no devolvió un CDC válido en el XML');
    }

    // 5. Validar XSD pre-firma
    const preValidation = await validatePreSigning(xml);
    if (!preValidation.valid) {
      throw new ValidationError('El XML no pasa validación XSD pre-firma', preValidation.errors);
    }

    let xmlFinal = xml;
    let signed = false;
    let sentToSifen = false;
    let sifenCodigoRespuesta: string | undefined;
    let sifenMensaje: string | undefined;
    let sifenProtocoloAutorizacion: string | undefined;
    let sifenLoteNumero: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sifenResponseRaw: Record<string, any> | undefined;
    let estado: 'pendiente' | 'aprobado' | 'rechazado' | 'error' = 'pendiente';

    // 6. Firmar + QR + enviar (gated por ENABLE_SIFEN)
    if (env.ENABLE_SIFEN) {
      // 6a. Firmar
      const certBundle = await loadTenantCertBundle(tenant.id, companyId);
      const xmlSigned = await signXmlWithBundle(xml, certBundle);
      signed = true;

      // 6b. Generar QR (si CSC está configurado). Va ANTES de la validación
      // XSD estricta: el XSD firmado exige el bloque gCamFuFD (dCarQR), que
      // es justamente lo que agrega qrgen. Sin CSC el XML queda sin QR y la
      // validación de abajo lo rechaza — correcto, SIFEN lo rechazaría igual.
      let xmlWithQr = xmlSigned;
      const csc = await decryptTenantCsc(tenant.id, companyId);
      if (csc) {
        xmlWithQr = await qrgen.generateQR(xmlSigned, csc.cscId, csc.csc, tenant.env);
      }

      // 6c. Validar XSD estricto (post-firma, con QR incluido)
      const postValidation = await validatePostSigning(xmlWithQr);
      if (!postValidation.valid) {
        throw new ValidationError(
          'El XML firmado no pasa validación XSD estricta',
          postValidation.errors,
        );
      }

      xmlFinal = xmlWithQr;
    }

    // 7. Subir XML a S3 SIEMPRE antes del envío — así el retry worker
    //    puede recuperar el XML firmado si hace falta reenviar.
    const xmlKey = storageKey.xml(companyId, tenant.id, cdc);
    await uploadObject(xmlKey, xmlFinal, { contentType: 'application/xml' });

    // 7b. Generar KUDE (PDF visual) — opcional, gated por ENABLE_KUDE.
    //     Requiere XML firmado con QR. Si falla, logueamos y seguimos —
    //     el KUDE se puede regenerar después desde el XML persistido.
    let kudeKey: string | null = null;
    if (env.ENABLE_SIFEN && env.ENABLE_KUDE) {
      const kudeResult = await generateKudePdf(xmlFinal);
      if (kudeResult.ok && kudeResult.pdfBuffer) {
        kudeKey = storageKey.kude(companyId, tenant.id, cdc);
        await uploadObject(kudeKey, kudeResult.pdfBuffer, { contentType: 'application/pdf' });
      } else {
        // No bloquea la emisión, pero el motivo TIENE que quedar en logs —
        // un fallo silencioso acá costó descubrir que el KUDE nunca se generó
        // eslint-disable-next-line no-console
        console.warn(`[kude] generación falló para CDC ${cdc}: ${kudeResult.reason ?? 'sin motivo'}`);
      }
    }

    // Guardamos el CDC y xml_storage_key ANTES de intentar enviar, así si el
    // envío falla el retry worker puede encontrar el document por CDC.
    await db
      .update(documents)
      .set({
        cdc,
        xmlStorageKey: xmlKey,
        kudeStorageKey: kudeKey,
        estado: env.ENABLE_SIFEN ? 'enviando' : 'pendiente',
        updatedAt: new Date(),
      })
      .where(eq(documents.id, docId));

    // 8. Enviar a SIFEN (gated por ENABLE_SIFEN). Si falla por error transitorio,
    //    encolamos un retry en vez de tirar error 5xx al cliente.
    if (env.ENABLE_SIFEN) {
      const certBundle = await loadTenantCertBundle(tenant.id, companyId);
      const decryptedCert = decryptCertBundle(certBundle);
      const sifenTmpPath = join(tmpdir(), `sifen-cert-${randomUUID()}.p12`);

      try {
        await writeFile(sifenTmpPath, decryptedCert.p12, { mode: 0o600 });

        // Envío por LOTE — el canal síncrono `recibe` está restringido en
        // producción (1264). Ver sifen-sender.ts.
        const sendResult = await sendDeViaLote({
          xml: xmlFinal,
          cdc,
          env: tenant.env,
          certPath: sifenTmpPath,
          certPassword: decryptedCert.password,
        });
        sifenResponseRaw = sendResult.raw;
        sentToSifen = true;
        sifenCodigoRespuesta = sendResult.codigo;
        sifenMensaje = sendResult.mensaje;
        sifenProtocoloAutorizacion = sendResult.protocoloAutorizacion;
        sifenLoteNumero = sendResult.loteNumero;

        if (sendResult.estado === 'error') {
          // SIFEN no aceptó el lote o la respuesta fue irreconocible —
          // mismo tratamiento que un fallo transitorio: retry worker
          throw new Error(
            `SIFEN lote no aceptado (${sendResult.codigo ?? 'sin código'}): ${sendResult.mensaje ?? ''}`,
          );
        }
        // 'aprobado' | 'rechazado' | 'enviando' (veredicto pendiente,
        // el retry worker lo resuelve consultando el lote)
        if (sendResult.estado === 'enviando') {
          estado = 'pendiente';
          void enqueueSifenRetry({ documentId: docId, companyId, tenantId: tenant.id, cdc }).catch(
            () => {
              // best effort — el cliente puede re-disparar con POST /de/:cdc/consulta
            },
          );
        } else {
          estado = sendResult.estado;
        }
      } catch (sifenErr) {
        // Error transitorio: network timeout, SIFEN 5xx, etc.
        // Marcamos como error y encolamos retry. El cliente recibe respuesta
        // indicando que el documento está en estado 'error' y el retry worker
        // va a intentar reenviarlo automáticamente con backoff.
        const msg = sifenErr instanceof Error ? sifenErr.message : String(sifenErr);

        await db
          .update(documents)
          .set({
            estado: 'error',
            errorMessage: `SIFEN send failed: ${msg}`,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, docId));

        // Fire-and-forget enqueue del retry. No bloqueamos la respuesta al
        // cliente por un error de BullMQ.
        void enqueueSifenRetry({
          documentId: docId,
          companyId,
          tenantId: tenant.id,
          cdc,
        }).catch(() => {
          // El error ya está persistido en el document row; el cliente puede
          // re-disparar manualmente con POST /de/:cdc/consulta si el retry
          // automático no se encoló.
        });

        throw new SifenError(
          `SIFEN envío falló (retry automático encolado): ${msg}`,
          { originalError: msg, documentId: docId, cdc },
        );
      } finally {
        decryptedCert.p12.fill(0);
        await unlink(sifenTmpPath).catch(() => {});
      }
    }

    // 9. Actualizar document row con el resultado final del envío
    await db
      .update(documents)
      .set({
        estado,
        sifenResponseRaw,
        sifenCodigoRespuesta,
        sifenMensaje,
        sifenProtocoloAutorizacion,
        sifenLoteNumero,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, docId));

    return {
      txnId: docId,
      cdc,
      estado,
      numero,
      establecimiento,
      punto,
      xmlStorageKey: xmlKey,
      sifenCodigoRespuesta,
      sifenMensaje,
      sifenProtocoloAutorizacion,
      signed,
      sentToSifen,
    };
  } catch (err) {
    // Rollback "lógico" del document row: lo dejamos en estado error con el mensaje
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(documents)
      .set({ estado: 'error', errorMessage: msg, updatedAt: new Date() })
      .where(eq(documents.id, docId));
    throw err;
  }
};

// ═════════════════════════════════════════════════════════════════
// Utilidades de respuesta SIFEN (best effort)
// ═════════════════════════════════════════════════════════════════

// Parsing de respuestas SIFEN calibrado con producción — ver lib/sifen-response.ts

/**
 * Calcula el monto total del documento sumando los items.
 * Simplificado para el MVP — el motor xmlgen es la fuente de verdad real.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const calcularMontoTotal = (body: Record<string, any>): number => {
  if (!Array.isArray(body.items)) return 0;
  let total = 0;
  for (const item of body.items) {
    const cant = Number(item.cantidad ?? 0);
    const precio = Number(item.precioUnitario ?? 0);
    total += cant * precio;
  }
  return total;
};
