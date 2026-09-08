DROP INDEX IF EXISTS "documents_cdc_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_cdc_unique" ON "documents" USING btree ("company_id","cdc");