/**
 * Setup links: carga segura de credenciales fiscales por el contribuyente.
 *
 * Problema que resuelve: el .p12, su contraseña y el CSC son credenciales
 * que permiten FIRMAR documentos fiscales en nombre del contribuyente. No
 * deben viajar por el canal del integrador — chat de un agente IA, tickets,
 * mail, capturas — porque quedan en transcripts y logs de terceros.
 *
 * Flujo: el integrador pide un link → se lo pasa al contribuyente → el
 * contribuyente sube sus credenciales directo al API por HTTPS → el link
 * se quema. El integrador (y el agente) nunca ven los secretos.
 *
 * El token se guarda hasheado (SHA-256): si se filtra la DB, los links
 * existentes no son usables.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { setupLinks, tenants } from '../db/schema.js';
import { NotFoundError, BadRequestError } from '../lib/errors.js';

const TOKEN_BYTES = 32; // 256 bits
export const DEFAULT_TTL_MINUTES = 60;

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export interface CreatedSetupLink {
  token: string; // se devuelve UNA sola vez
  expiresAt: Date;
}

export const createSetupLink = async (input: {
  companyId: string;
  tenantId: string;
  ttlMinutes?: number;
}): Promise<CreatedSetupLink> => {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.id, input.tenantId), eq(tenants.companyId, input.companyId)))
    .limit(1);
  if (!tenant) throw new NotFoundError('Tenant');

  const ttl = Math.min(Math.max(input.ttlMinutes ?? DEFAULT_TTL_MINUTES, 5), 60 * 24);
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  await db.insert(setupLinks).values({
    companyId: input.companyId,
    tenantId: input.tenantId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return { token, expiresAt };
};

export interface ResolvedSetupLink {
  id: string;
  companyId: string;
  tenantId: string;
  razonSocial: string;
  ruc: string;
}

/** Valida un token: existe, no vencido, no usado. Devuelve el contexto. */
export const resolveSetupLink = async (token: string): Promise<ResolvedSetupLink> => {
  const hash = hashToken(token);
  const [row] = await db
    .select({
      id: setupLinks.id,
      companyId: setupLinks.companyId,
      tenantId: setupLinks.tenantId,
      tokenHash: setupLinks.tokenHash,
      expiresAt: setupLinks.expiresAt,
      usedAt: setupLinks.usedAt,
      razonSocial: tenants.razonSocial,
      ruc: tenants.ruc,
    })
    .from(setupLinks)
    .innerJoin(tenants, eq(tenants.id, setupLinks.tenantId))
    .where(eq(setupLinks.tokenHash, hash))
    .limit(1);

  if (!row) throw new NotFoundError('Link de configuración');

  // defensa en profundidad: comparación constant-time del hash
  const a = Buffer.from(row.tokenHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new NotFoundError('Link de configuración');
  }
  if (row.usedAt) throw new BadRequestError('Este link ya fue utilizado');
  if (row.expiresAt < new Date()) throw new BadRequestError('Este link expiró');

  return {
    id: row.id,
    companyId: row.companyId,
    tenantId: row.tenantId,
    razonSocial: row.razonSocial,
    ruc: row.ruc,
  };
};

export const markSetupLinkUsed = async (id: string): Promise<void> => {
  await db.update(setupLinks).set({ usedAt: new Date() }).where(eq(setupLinks.id, id));
};
