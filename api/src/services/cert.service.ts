/**
 * Cert service: parseo, validación y almacenamiento seguro de certificados PKCS#12.
 *
 * Flujo de alta:
 *   1. Cliente hace POST multipart con el .p12 + password
 *   2. parseAndValidate() descifra el p12 con node-forge y extrae metadata
 *   3. Verificamos que:
 *      - La password sea correcta (descifra OK)
 *      - El RUC del CN del cert coincida con el RUC del tenant declarado
 *      - El cert no esté vencido
 *      - El cert no haya sido revocado (si hay lista de revocación — out of scope MVP)
 *   4. Si todo OK, envelopeEncrypt del .p12 + password + guardar en DB
 *
 * Flujo de uso (firmado):
 *   1. Buscar tenant_certs por tenant_id (y company_id para defensa en profundidad)
 *   2. envelopeDecrypt del .p12 y password
 *   3. Escribir temp file con perms 0600, llamar xmlsign, borrar temp file
 *   4. Wipe de buffers sensibles en memoria
 */
import forge from 'node-forge';
import { createHash, randomBytes } from 'node:crypto';
import {
  encryptWithKey,
  decryptWithKey,
  type EncryptedBlob,
} from '../crypto/envelope.js';
import { env } from '../config/env.js';
import { BadRequestError, ValidationError } from '../lib/errors.js';

const { pki, asn1, pkcs12 } = forge;
type Asn1 = forge.asn1.Asn1;
type Pkcs12Pfx = forge.pkcs12.Pkcs12Pfx;
type Certificate = forge.pki.Certificate;

export interface CertMetadata {
  fingerprint: string;
  subjectCn: string;
  subjectRuc: string; // extraído del CN o del serialNumber
  notBefore: Date;
  notAfter: Date;
}

export interface ParsedCert {
  metadata: CertMetadata;
  /** Cert PEM para debug — no se persiste */
  certPem?: string;
}

/**
 * Bundle cifrado del cert: comparte UNA DEK para p12 y password.
 *
 * El schema DB `tenant_certs` tiene UNA sola columna encrypted_dek + iv_dek + tag_dek,
 * y por eso acá usamos una DEK única y dos EncryptedBlob separados (uno para el p12,
 * otro para la password). Ambos se descifran con la misma DEK.
 *
 * Esto es distinto del `envelopeEncrypt()` genérico que genera su propia DEK — para
 * el cert bundle necesitamos control explícito de la DEK para que coincida con el
 * schema.
 */
export interface EncryptedCertBundle {
  p12: EncryptedBlob;
  password: EncryptedBlob;
  dek: EncryptedBlob; // DEK cifrada con la KEK master
}

/**
 * Extrae el RUC del subject de un certificado SIFEN.
 *
 * El RUC puede venir de dos formas según cómo lo emita la CA:
 *   - En el CN:           "CN=Juan Perez 80012345-1" o "CN=EMPRESA SA:80012345-1"
 *   - En el serialNumber: "serialNumber=RUC 80012345-1"
 *
 * Normalizamos a formato sin dígito verificador: "80012345"
 * (SIFEN compara sin DV en la mayoría de flujos)
 */
const extractRucFromSubject = (cert: Certificate): string | null => {
  const attrs = cert.subject.attributes;

  // Intento 1: serialNumber (más confiable cuando está)
  const sn = attrs.find((a) => a.name === 'serialNumber' || a.shortName === 'serialNumber');
  if (sn && typeof sn.value === 'string') {
    const match = sn.value.match(/(\d{6,9})[-]?(\d)?/);
    if (match) return match[1];
  }

  // Intento 2: CN — buscar patrón RUC numérico al final
  const cn = attrs.find((a) => a.name === 'commonName' || a.shortName === 'CN');
  if (cn && typeof cn.value === 'string') {
    // Patrones: "Nombre 80012345-1", "Nombre:80012345", "Nombre (80012345-1)"
    const match = cn.value.match(/(\d{6,9})-?\d?/);
    if (match) return match[1];
  }

  return null;
};

/**
 * Parsea un .p12 con password, extrae el cert principal y su metadata.
 * Lanza BadRequestError si la password es incorrecta o el archivo está corrupto.
 */
export const parseP12 = (p12Buffer: Buffer, password: string): ParsedCert => {
  let p12Asn1: Asn1;
  try {
    // node-forge acepta un binary string directamente en fromDer
    p12Asn1 = asn1.fromDer(p12Buffer.toString('binary'));
  } catch {
    throw new BadRequestError('El archivo no es un PKCS#12 válido');
  }

  let p12: Pkcs12Pfx;
  try {
    p12 = pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
  } catch (err) {
    // node-forge lanza "PKCS#12 MAC could not be verified" si el password es incorrecto
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('MAC') || msg.includes('password')) {
      throw new BadRequestError('Contraseña del certificado incorrecta');
    }
    throw new BadRequestError(`Error al leer el certificado: ${msg}`);
  }

  // Buscar el primer cert en los safe contents
  let cert: Certificate | null = null;
  for (const safeContent of p12.safeContents) {
    for (const safeBag of safeContent.safeBags) {
      if (safeBag.type === pki.oids.certBag && safeBag.cert) {
        cert = safeBag.cert;
        break;
      }
    }
    if (cert) break;
  }

  if (!cert) {
    throw new BadRequestError('El PKCS#12 no contiene un certificado válido');
  }

  // Metadata
  const certDer = asn1.toDer(pki.certificateToAsn1(cert)).getBytes();
  const fingerprint = createHash('sha256').update(certDer, 'binary').digest('hex');

  const cnAttr = cert.subject.attributes.find((a) => a.name === 'commonName' || a.shortName === 'CN');
  const subjectCn = (cnAttr?.value as string) ?? 'Unknown';

  const ruc = extractRucFromSubject(cert);
  if (!ruc) {
    throw new ValidationError('No se pudo extraer el RUC del certificado', {
      hint: 'El CN o serialNumber del certificado debe contener el RUC del emisor',
      subject: subjectCn,
    });
  }

  const notBefore = cert.validity.notBefore;
  const notAfter = cert.validity.notAfter;

  return {
    metadata: {
      fingerprint,
      subjectCn,
      subjectRuc: ruc,
      notBefore,
      notAfter,
    },
    certPem: pki.certificateToPem(cert),
  };
};

/**
 * Normaliza un RUC a formato sin dígito verificador y sin espacios.
 *   "80012345-1" → "80012345"
 *   "80012345"   → "80012345"
 */
export const normalizeRuc = (ruc: string): string => {
  const trimmed = ruc.replace(/\s/g, '');
  const dashIdx = trimmed.indexOf('-');
  return dashIdx >= 0 ? trimmed.slice(0, dashIdx) : trimmed;
};

/**
 * Valida que el cert esté dentro de su ventana de validez.
 */
export const assertCertNotExpired = (metadata: CertMetadata, now = new Date()): void => {
  if (now < metadata.notBefore) {
    throw new ValidationError('El certificado aún no es válido (notBefore en el futuro)', {
      notBefore: metadata.notBefore.toISOString(),
    });
  }
  if (now > metadata.notAfter) {
    throw new ValidationError('El certificado está vencido', {
      notAfter: metadata.notAfter.toISOString(),
      expiredSince: Math.floor((now.getTime() - metadata.notAfter.getTime()) / 86400000) + ' días',
    });
  }
};

/**
 * Valida que el RUC del cert coincida con el RUC del tenant.
 * Compara ignorando dígito verificador.
 */
export const assertRucMatches = (certRuc: string, tenantRuc: string): void => {
  const normCert = normalizeRuc(certRuc);
  const normTenant = normalizeRuc(tenantRuc);
  if (normCert !== normTenant) {
    throw new ValidationError(
      `El RUC del certificado (${certRuc}) no coincide con el del tenant (${tenantRuc})`,
    );
  }
};

const getKek = (): Buffer => Buffer.from(env.MASTER_KEY_BASE64, 'base64');

/**
 * Cifra el .p12 y su password con UNA DEK compartida, y cifra la DEK con la KEK.
 * Devuelve los 3 blobs (p12, password, dek) que el caller persiste en las
 * columnas correspondientes de tenant_certs.
 *
 * Los buffers de input se zero-ean al terminar.
 */
export const encryptCertBundle = (
  p12Buffer: Buffer,
  password: string,
): EncryptedCertBundle => {
  const dek = randomBytes(32);
  const passwordBuffer = Buffer.from(password, 'utf8');
  try {
    const p12Blob = encryptWithKey(p12Buffer, dek);
    const pwdBlob = encryptWithKey(passwordBuffer, dek);
    const dekBlob = encryptWithKey(dek, getKek());
    return { p12: p12Blob, password: pwdBlob, dek: dekBlob };
  } finally {
    dek.fill(0);
    passwordBuffer.fill(0);
  }
};

/**
 * Descifra el bundle en memoria. Primero descifra la DEK con la KEK, luego usa la
 * misma DEK para descifrar ambos blobs (p12 + password).
 *
 * La DEK se zera al terminar. El caller es responsable de wipe los buffers
 * devueltos cuando termine de usarlos.
 */
export const decryptCertBundle = (
  bundle: EncryptedCertBundle,
): { p12: Buffer; password: string } => {
  const dek = decryptWithKey(bundle.dek, getKek());
  try {
    const p12 = decryptWithKey(bundle.p12, dek);
    const passwordBuf = decryptWithKey(bundle.password, dek);
    const password = passwordBuf.toString('utf8');
    passwordBuf.fill(0);
    return { p12, password };
  } finally {
    dek.fill(0);
  }
};
