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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const setapi = require('facturacionelectronicapy-setapi').default;

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
  signed: boolean;
  sentToSifen: boolean;
}

// ═════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════

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
    const fecha = body.fecha ?? new Date().toISOString().slice(0, 19);

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
        cdc: '', // temporal, se llena después
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
    const xml: string = await xmlgen.generateXMLDE(params, dataForXmlgen);

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sifenResponseRaw: Record<string, any> | undefined;
    let estado: 'pendiente' | 'aprobado' | 'rechazado' | 'error' = 'pendiente';

    // 6. Firmar + QR + enviar (gated por ENABLE_SIFEN)
    if (env.ENABLE_SIFEN) {
      // 6a. Firmar
      const certBundle = await loadTenantCertBundle(tenant.id, companyId);
      const xmlSigned = await signXmlWithBundle(xml, certBundle);
      signed = true;

      // 6b. Validar XSD estricto (post-firma)
      const postValidation = await validatePostSigning(xmlSigned);
      if (!postValidation.valid) {
        throw new ValidationError(
          'El XML firmado no pasa validación XSD estricta',
          postValidation.errors,
        );
      }

      // 6c. Generar QR (opcional, si CSC está configurado)
      let xmlWithQr = xmlSigned;
      const csc = await decryptTenantCsc(tenant.id, companyId);
      if (csc) {
        xmlWithQr = await qrgen.generateQR(xmlSigned, csc.cscId, csc.csc, tenant.env);
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
      }
      // Si kudeResult.ok === false, no es error — el cliente puede pedir
      // regeneración después vía un endpoint dedicado (TODO en Fase 3)
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
        const requestId = Number(Date.now() % 1_000_000);

        const response = await setapi.recibe(
          requestId,
          xmlFinal,
          tenant.env,
          sifenTmpPath,
          decryptedCert.password,
        );
        sifenResponseRaw =
          typeof response === 'string' ? { raw: response } : (response as Record<string, unknown>);
        sentToSifen = true;

        // Calibrar con respuestas reales en Fase 1 — estos códigos son placeholder
        const codigo = extractSifenCodigo(sifenResponseRaw);
        const mensaje = extractSifenMensaje(sifenResponseRaw);
        sifenCodigoRespuesta = codigo;
        sifenMensaje = mensaje;

        if (codigo && (codigo === '0260' || codigo === '0261' || codigo === '0262')) {
          estado = 'aprobado';
        } else {
          estado = 'rechazado';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractSifenCodigo = (resp: Record<string, any>): string | undefined => {
  // Las respuestas reales de SIFEN vienen en SOAP con campos como
  // rResEnviDe/gResProcDE/dCodRes — esta función es placeholder hasta
  // que tengamos un cert real y podamos inspeccionar las respuestas.
  return (
    resp?.dCodRes ??
    resp?.gResProcDE?.dCodRes ??
    resp?.rResEnviDe?.gResProcDE?.dCodRes ??
    undefined
  );
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractSifenMensaje = (resp: Record<string, any>): string | undefined => {
  return (
    resp?.dMsgRes ??
    resp?.gResProcDE?.dMsgRes ??
    resp?.rResEnviDe?.gResProcDE?.dMsgRes ??
    undefined
  );
};

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
