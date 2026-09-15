DROP INDEX IF EXISTS "documents_cdc_unique";--> statement-breakpoint
ALTER TABLE "numeracion" ADD COLUMN "serie" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_cdc_unique" ON "documents" USING btree ("company_id","cdc") WHERE estado NOT IN ('rechazado', 'error');--> statement-breakpoint
ALTER TABLE "numeracion" ADD CONSTRAINT "numeracion_serie_formato" CHECK ("serie" IS NULL OR "serie" ~ '^[A-Z]{2}$');
