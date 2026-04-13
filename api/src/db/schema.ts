import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  smallint,
  jsonb,
  numeric,
  date,
  index,
  uniqueIndex,
  primaryKey,
  pgEnum,
  customType,
} from 'drizzle-orm/pg-core';

// ──────────────────────────────────────────────────────────────
// Custom bytea type (Drizzle no lo tiene nativo en drizzle-orm/pg-core)
// ──────────────────────────────────────────────────────────────
const byteaColumn = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

// ──────────────────────────────────────────────────────────────
// Enums
// ──────────────────────────────────────────────────────────────
export const companyStatusEnum = pgEnum('company_status', ['active', 'suspended', 'deleted']);
export const tenantStatusEnum = pgEnum('tenant_status', ['active', 'suspended']);
export const sifenEnvEnum = pgEnum('sifen_env', ['test', 'prod']);
export const documentEstadoEnum = pgEnum('document_estado', [
  'pendiente',
  'generando',
  'firmando',
  'enviando',
  'aprobado',
  'rechazado',
  'error',
]);
export const eventoTipoEnum = pgEnum('evento_tipo', [
  'cancelacion',
  'inutilizacion',
  'conformidad',
  'disconformidad',
  'desconocimiento',
  'notificacion',
  'nominacion',
  'actualizacion_transporte',
]);
export const eventoEstadoEnum = pgEnum('evento_estado', ['pendiente', 'enviado', 'aprobado', 'rechazado', 'error']);

// ──────────────────────────────────────────────────────────────
// companies — plataformas clientes del servicio (Company A, B, ...)
// ──────────────────────────────────────────────────────────────
export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    apiKeyHash: text('api_key_hash').notNull(),
    apiKeyPrefix: text('api_key_prefix').notNull(), // "cmp_abc123" - primeros chars, buscable
    status: companyStatusEnum('status').notNull().default('active'),
    billingEmail: text('billing_email'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUnique: uniqueIndex('companies_email_unique').on(t.email),
    apiKeyPrefixIdx: index('companies_api_key_prefix_idx').on(t.apiKeyPrefix),
  }),
);

// ──────────────────────────────────────────────────────────────
// tenants — contribuyentes emisores (los RUCs que emiten facturas)
// ──────────────────────────────────────────────────────────────
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    externalId: text('external_id'), // ID interno de la Company
    ruc: text('ruc').notNull(),
    razonSocial: text('razon_social').notNull(),
    nombreFantasia: text('nombre_fantasia'),
    timbradoNumero: text('timbrado_numero').notNull(),
    timbradoFecha: date('timbrado_fecha').notNull(),
    timbradoVencimiento: date('timbrado_vencimiento'),
    tipoContribuyente: smallint('tipo_contribuyente').notNull(),
    tipoRegimen: smallint('tipo_regimen').notNull(),
    establecimientos: jsonb('establecimientos').$type<
      Array<{
        codigo: string;
        direccion: string;
        numeroCasa?: string;
        complementoDireccion1?: string;
        complementoDireccion2?: string;
        departamento: number;
        departamentoDescripcion: string;
        distrito: number;
        distritoDescripcion: string;
        ciudad: number;
        ciudadDescripcion: string;
        telefono?: string;
        email?: string;
        denominacion?: string;
      }>
    >().notNull(),
    actividadesEconomicas: jsonb('actividades_economicas').$type<
      Array<{ codigo: string; descripcion: string }>
    >().notNull(),
    env: sifenEnvEnum('env').notNull().default('test'),
    status: tenantStatusEnum('status').notNull().default('active'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyRucUnique: uniqueIndex('tenants_company_ruc_unique').on(t.companyId, t.ruc),
    companyIdx: index('tenants_company_idx').on(t.companyId),
    externalIdIdx: index('tenants_external_id_idx').on(t.companyId, t.externalId),
  }),
);

// ──────────────────────────────────────────────────────────────
// tenant_certs — certificados .p12 cifrados (envelope encryption)
// ──────────────────────────────────────────────────────────────
export const tenantCerts = pgTable(
  'tenant_certs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull(), // denormalizado para filtros rápidos + RLS

    // blobs cifrados
    encryptedP12: byteaColumn('encrypted_p12').notNull(),
    encryptedPassword: byteaColumn('encrypted_password').notNull(),
    encryptedDek: byteaColumn('encrypted_dek').notNull(),

    // IVs separados por blob
    ivP12: byteaColumn('iv_p12').notNull(),
    ivPassword: byteaColumn('iv_password').notNull(),
    ivDek: byteaColumn('iv_dek').notNull(),

    // auth tags de AES-GCM
    tagP12: byteaColumn('tag_p12').notNull(),
    tagPassword: byteaColumn('tag_password').notNull(),
    tagDek: byteaColumn('tag_dek').notNull(),

    // metadata del cert (extraída al upload)
    fingerprint: text('fingerprint').notNull(), // SHA256 para dedupe
    subjectCn: text('subject_cn').notNull(),
    subjectRuc: text('subject_ruc').notNull(), // extraído, debe coincidir con tenants.ruc
    notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
    notAfter: timestamp('not_after', { withTimezone: true }).notNull(),

    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    tenantUnique: uniqueIndex('tenant_certs_tenant_unique').on(t.tenantId),
    companyIdx: index('tenant_certs_company_idx').on(t.companyId),
    expirationIdx: index('tenant_certs_expiration_idx').on(t.notAfter),
  }),
);

// ──────────────────────────────────────────────────────────────
// tenant_csc — CSC cifrado (rota independiente del cert)
// ──────────────────────────────────────────────────────────────
export const tenantCsc = pgTable(
  'tenant_csc',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull(),
    cscId: text('csc_id').notNull(),
    encryptedCsc: byteaColumn('encrypted_csc').notNull(),
    encryptedDek: byteaColumn('encrypted_dek').notNull(),
    ivCsc: byteaColumn('iv_csc').notNull(),
    ivDek: byteaColumn('iv_dek').notNull(),
    tagCsc: byteaColumn('tag_csc').notNull(),
    tagDek: byteaColumn('tag_dek').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('tenant_csc_company_idx').on(t.companyId),
  }),
);

// ──────────────────────────────────────────────────────────────
// documents — facturas/notas emitidas
// ──────────────────────────────────────────────────────────────
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(), // txn_id interno
    companyId: uuid('company_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cdc: text('cdc').notNull(), // 44 dígitos
    tipo: smallint('tipo').notNull(), // 1=FE, 5=NC (MVP)
    establecimiento: text('establecimiento').notNull(),
    punto: text('punto').notNull(),
    numero: text('numero').notNull(),
    fechaEmision: timestamp('fecha_emision', { withTimezone: true }).notNull(),
    moneda: text('moneda').notNull().default('PYG'),
    montoTotal: numeric('monto_total', { precision: 18, scale: 4 }).notNull(),
    estado: documentEstadoEnum('estado').notNull().default('pendiente'),

    // datos de entrada y resultado
    requestJson: jsonb('request_json').$type<Record<string, unknown>>().notNull(),
    xmlStorageKey: text('xml_storage_key'),
    kudeStorageKey: text('kude_storage_key'),
    sifenResponseRaw: jsonb('sifen_response_raw').$type<Record<string, unknown>>(),
    sifenCodigoRespuesta: text('sifen_codigo_respuesta'),
    sifenMensaje: text('sifen_mensaje'),

    // operacional
    idempotencyKey: text('idempotency_key'),
    retries: smallint('retries').notNull().default(0),
    errorMessage: text('error_message'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    cdcUnique: uniqueIndex('documents_cdc_unique').on(t.cdc),
    tenantNumeroUnique: uniqueIndex('documents_tenant_numero_unique').on(
      t.tenantId,
      t.tipo,
      t.establecimiento,
      t.punto,
      t.numero,
    ),
    companyTenantCreatedIdx: index('documents_company_tenant_created_idx').on(
      t.companyId,
      t.tenantId,
      t.createdAt,
    ),
    estadoIdx: index('documents_estado_idx').on(t.estado),
  }),
);

// ──────────────────────────────────────────────────────────────
// numeracion — secuencia por tenant/tipo/establecimiento/punto
// ──────────────────────────────────────────────────────────────
export const numeracion = pgTable(
  'numeracion',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    tipo: smallint('tipo').notNull(),
    establecimiento: text('establecimiento').notNull(),
    punto: text('punto').notNull(),
    ultimoNumero: bigint('ultimo_numero', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.tipo, t.establecimiento, t.punto] }),
  }),
);

// ──────────────────────────────────────────────────────────────
// eventos — cancelación, inutilización, etc.
// ──────────────────────────────────────────────────────────────
export const eventos = pgTable(
  'eventos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    documentCdc: text('document_cdc'), // null para inutilización masiva
    tipoEvento: eventoTipoEnum('tipo_evento').notNull(),
    requestJson: jsonb('request_json').$type<Record<string, unknown>>().notNull(),
    xmlStorageKey: text('xml_storage_key'),
    sifenResponseRaw: jsonb('sifen_response_raw').$type<Record<string, unknown>>(),
    estado: eventoEstadoEnum('estado').notNull().default('pendiente'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyTenantIdx: index('eventos_company_tenant_idx').on(t.companyId, t.tenantId, t.createdAt),
    cdcIdx: index('eventos_cdc_idx').on(t.documentCdc),
  }),
);

// ──────────────────────────────────────────────────────────────
// idempotency_keys — dedup de POST /de en ventana de 24h
// ──────────────────────────────────────────────────────────────
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    companyId: uuid('company_id').notNull(),
    key: text('key').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    requestHash: text('request_hash').notNull(), // SHA256 del body
    responseJson: jsonb('response_json').$type<Record<string, unknown>>(),
    documentId: uuid('document_id'), // FK lógica a documents.id
    statusCode: integer('status_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.companyId, t.key] }),
    expiresIdx: index('idempotency_expires_idx').on(t.expiresAt),
  }),
);

// ──────────────────────────────────────────────────────────────
// api_logs — auditoría sin payloads sensibles
// ──────────────────────────────────────────────────────────────
export const apiLogs = pgTable(
  'api_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id'),
    tenantId: uuid('tenant_id'),
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: smallint('status_code').notNull(),
    durationMs: integer('duration_ms').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyCreatedIdx: index('api_logs_company_created_idx').on(t.companyId, t.createdAt),
  }),
);

// ──────────────────────────────────────────────────────────────
// Tipos derivados para usar en servicios
// ──────────────────────────────────────────────────────────────
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantCert = typeof tenantCerts.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type EventoRow = typeof eventos.$inferSelect;
