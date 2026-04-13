/**
 * Tenant service: CRUD scoped a una company.
 *
 * Regla de oro: TODAS las queries filtran por company_id como primer WHERE.
 * Si un tenant no pertenece a la company que consulta, devolvemos null
 * (las rutas lo traducen a NotFoundError → 404, nunca 403).
 */
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, type Tenant, type NewTenant } from '../db/schema.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';

export interface CreateTenantInput {
  companyId: string;
  externalId?: string;
  ruc: string;
  razonSocial: string;
  nombreFantasia?: string;
  timbradoNumero: string;
  timbradoFecha: string; // YYYY-MM-DD
  timbradoVencimiento?: string;
  tipoContribuyente: number;
  tipoRegimen: number;
  establecimientos: NewTenant['establecimientos'];
  actividadesEconomicas: NewTenant['actividadesEconomicas'];
  env?: 'test' | 'prod';
}

export interface UpdateTenantInput {
  externalId?: string;
  razonSocial?: string;
  nombreFantasia?: string;
  timbradoNumero?: string;
  timbradoFecha?: string;
  timbradoVencimiento?: string;
  tipoContribuyente?: number;
  tipoRegimen?: number;
  establecimientos?: NewTenant['establecimientos'];
  actividadesEconomicas?: NewTenant['actividadesEconomicas'];
  env?: 'test' | 'prod';
  status?: 'active' | 'suspended';
}

/**
 * Crea un tenant para una company. Falla si el RUC ya existe en esa company.
 */
export const createTenant = async (input: CreateTenantInput): Promise<Tenant> => {
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.companyId, input.companyId), eq(tenants.ruc, input.ruc)))
    .limit(1);

  if (existing.length > 0) {
    throw new ConflictError(`Ya existe un tenant con RUC ${input.ruc} en esta company`);
  }

  const [inserted] = await db
    .insert(tenants)
    .values({
      companyId: input.companyId,
      externalId: input.externalId,
      ruc: input.ruc,
      razonSocial: input.razonSocial,
      nombreFantasia: input.nombreFantasia,
      timbradoNumero: input.timbradoNumero,
      timbradoFecha: input.timbradoFecha,
      timbradoVencimiento: input.timbradoVencimiento,
      tipoContribuyente: input.tipoContribuyente,
      tipoRegimen: input.tipoRegimen,
      establecimientos: input.establecimientos,
      actividadesEconomicas: input.actividadesEconomicas,
      env: input.env ?? 'test',
      status: 'active',
    })
    .returning();

  return inserted;
};

/**
 * Busca un tenant por ID verificando que pertenezca a la company.
 * Devuelve null si no existe O si pertenece a otra company (ambos casos = 404).
 */
export const findTenantByIdForCompany = async (
  companyId: string,
  tenantId: string,
): Promise<Tenant | null> => {
  const [row] = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.companyId, companyId), eq(tenants.id, tenantId)))
    .limit(1);
  return row ?? null;
};

/**
 * Helper que lanza NotFoundError si el tenant no existe o no pertenece a la company.
 */
export const requireTenantForCompany = async (
  companyId: string,
  tenantId: string,
): Promise<Tenant> => {
  const tenant = await findTenantByIdForCompany(companyId, tenantId);
  if (!tenant) throw new NotFoundError('Tenant');
  return tenant;
};

/**
 * Lista tenants de una company, paginado.
 */
export const listTenantsByCompany = async (
  companyId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<Tenant[]> => {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  return db
    .select()
    .from(tenants)
    .where(eq(tenants.companyId, companyId))
    .orderBy(desc(tenants.createdAt))
    .limit(limit)
    .offset(offset);
};

/**
 * Actualiza un tenant. Solo campos del input (no sobreescribe con undefined).
 */
export const updateTenant = async (
  companyId: string,
  tenantId: string,
  input: UpdateTenantInput,
): Promise<Tenant> => {
  await requireTenantForCompany(companyId, tenantId);

  const patch: Partial<NewTenant> = { updatedAt: new Date() };
  if (input.externalId !== undefined) patch.externalId = input.externalId;
  if (input.razonSocial !== undefined) patch.razonSocial = input.razonSocial;
  if (input.nombreFantasia !== undefined) patch.nombreFantasia = input.nombreFantasia;
  if (input.timbradoNumero !== undefined) patch.timbradoNumero = input.timbradoNumero;
  if (input.timbradoFecha !== undefined) patch.timbradoFecha = input.timbradoFecha;
  if (input.timbradoVencimiento !== undefined) patch.timbradoVencimiento = input.timbradoVencimiento;
  if (input.tipoContribuyente !== undefined) patch.tipoContribuyente = input.tipoContribuyente;
  if (input.tipoRegimen !== undefined) patch.tipoRegimen = input.tipoRegimen;
  if (input.establecimientos !== undefined) patch.establecimientos = input.establecimientos;
  if (input.actividadesEconomicas !== undefined) patch.actividadesEconomicas = input.actividadesEconomicas;
  if (input.env !== undefined) patch.env = input.env;
  if (input.status !== undefined) patch.status = input.status;

  const [updated] = await db
    .update(tenants)
    .set(patch)
    .where(and(eq(tenants.companyId, companyId), eq(tenants.id, tenantId)))
    .returning();

  return updated;
};

/**
 * Soft delete: marca como suspended. No borra físicamente para preservar audit trail.
 */
export const suspendTenant = async (companyId: string, tenantId: string): Promise<void> => {
  await requireTenantForCompany(companyId, tenantId);
  await db
    .update(tenants)
    .set({ status: 'suspended', updatedAt: new Date() })
    .where(and(eq(tenants.companyId, companyId), eq(tenants.id, tenantId)));
};
