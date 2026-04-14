CREATE TYPE "public"."company_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."document_estado" AS ENUM('pendiente', 'generando', 'firmando', 'enviando', 'aprobado', 'rechazado', 'error');--> statement-breakpoint
CREATE TYPE "public"."evento_estado" AS ENUM('pendiente', 'enviado', 'aprobado', 'rechazado', 'error');--> statement-breakpoint
CREATE TYPE "public"."evento_tipo" AS ENUM('cancelacion', 'inutilizacion', 'conformidad', 'disconformidad', 'desconocimiento', 'notificacion', 'nominacion', 'actualizacion_transporte');--> statement-breakpoint
CREATE TYPE "public"."sifen_env" AS ENUM('test', 'prod');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"tenant_id" uuid,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status_code" smallint NOT NULL,
	"duration_ms" integer NOT NULL,
	"user_agent" text,
	"ip" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"status" "company_status" DEFAULT 'active' NOT NULL,
	"billing_email" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cdc" text,
	"tipo" smallint NOT NULL,
	"establecimiento" text NOT NULL,
	"punto" text NOT NULL,
	"numero" text NOT NULL,
	"fecha_emision" timestamp with time zone NOT NULL,
	"moneda" text DEFAULT 'PYG' NOT NULL,
	"monto_total" numeric(18, 4) NOT NULL,
	"estado" "document_estado" DEFAULT 'pendiente' NOT NULL,
	"request_json" jsonb NOT NULL,
	"xml_storage_key" text,
	"kude_storage_key" text,
	"sifen_response_raw" jsonb,
	"sifen_codigo_respuesta" text,
	"sifen_mensaje" text,
	"idempotency_key" text,
	"retries" smallint DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eventos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_cdc" text,
	"tipo_evento" "evento_tipo" NOT NULL,
	"request_json" jsonb NOT NULL,
	"xml_storage_key" text,
	"sifen_response_raw" jsonb,
	"estado" "evento_estado" DEFAULT 'pendiente' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response_json" jsonb,
	"document_id" uuid,
	"status_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_company_id_key_pk" PRIMARY KEY("company_id","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "numeracion" (
	"tenant_id" uuid NOT NULL,
	"tipo" smallint NOT NULL,
	"establecimiento" text NOT NULL,
	"punto" text NOT NULL,
	"ultimo_numero" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "numeracion_tenant_id_tipo_establecimiento_punto_pk" PRIMARY KEY("tenant_id","tipo","establecimiento","punto")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_certs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"encrypted_p12" "bytea" NOT NULL,
	"encrypted_password" "bytea" NOT NULL,
	"encrypted_dek" "bytea" NOT NULL,
	"iv_p12" "bytea" NOT NULL,
	"iv_password" "bytea" NOT NULL,
	"iv_dek" "bytea" NOT NULL,
	"tag_p12" "bytea" NOT NULL,
	"tag_password" "bytea" NOT NULL,
	"tag_dek" "bytea" NOT NULL,
	"fingerprint" text NOT NULL,
	"subject_cn" text NOT NULL,
	"subject_ruc" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_csc" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"csc_id" text NOT NULL,
	"encrypted_csc" "bytea" NOT NULL,
	"encrypted_dek" "bytea" NOT NULL,
	"iv_csc" "bytea" NOT NULL,
	"iv_dek" "bytea" NOT NULL,
	"tag_csc" "bytea" NOT NULL,
	"tag_dek" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"external_id" text,
	"ruc" text NOT NULL,
	"razon_social" text NOT NULL,
	"nombre_fantasia" text,
	"timbrado_numero" text NOT NULL,
	"timbrado_fecha" date NOT NULL,
	"timbrado_vencimiento" date,
	"tipo_contribuyente" smallint NOT NULL,
	"tipo_regimen" smallint NOT NULL,
	"establecimientos" jsonb NOT NULL,
	"actividades_economicas" jsonb NOT NULL,
	"env" "sifen_env" DEFAULT 'test' NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eventos" ADD CONSTRAINT "eventos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "numeracion" ADD CONSTRAINT "numeracion_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_certs" ADD CONSTRAINT "tenant_certs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_csc" ADD CONSTRAINT "tenant_csc_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenants" ADD CONSTRAINT "tenants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_logs_company_created_idx" ON "api_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_email_unique" ON "companies" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_api_key_prefix_idx" ON "companies" USING btree ("api_key_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_cdc_unique" ON "documents" USING btree ("cdc");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_tenant_numero_unique" ON "documents" USING btree ("tenant_id","tipo","establecimiento","punto","numero");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_company_tenant_created_idx" ON "documents" USING btree ("company_id","tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_estado_idx" ON "documents" USING btree ("estado");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eventos_company_tenant_idx" ON "eventos" USING btree ("company_id","tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eventos_cdc_idx" ON "eventos" USING btree ("document_cdc");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_certs_tenant_unique" ON "tenant_certs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_certs_company_idx" ON "tenant_certs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_certs_expiration_idx" ON "tenant_certs" USING btree ("not_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_csc_company_idx" ON "tenant_csc" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_company_ruc_unique" ON "tenants" USING btree ("company_id","ruc");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_company_idx" ON "tenants" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_external_id_idx" ON "tenants" USING btree ("company_id","external_id");