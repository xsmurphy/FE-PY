/**
 * Búsqueda de documentos por CDC.
 *
 * El CDC NO es único por fila: el índice `documents_cdc_unique` es parcial
 * (excluye rechazado/error) porque SIFEN no registra un DE rechazado y
 * reenviar el mismo CDC es legítimo. Un mismo CDC puede tener entonces
 * varios intentos fallidos y, como mucho, uno vigente.
 *
 * Toda lectura por CDC pasa por acá para que ninguna ruta devuelva por azar
 * un intento rechazado cuando existe el aprobado — mostrar, cancelar o
 * bajar el KUDE del intento equivocado es un error con efecto fiscal.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, type DocumentRow } from '../db/schema.js';

export const findDocumentByCdc = async (input: {
  companyId: string;
  tenantId: string;
  cdc: string;
}): Promise<DocumentRow | null> => {
  const [row] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.companyId, input.companyId),
        eq(documents.tenantId, input.tenantId),
        eq(documents.cdc, input.cdc),
      ),
    )
    // El vigente primero (a lo sumo hay uno, lo garantiza el índice); si no
    // hay vigente, el intento más reciente.
    .orderBy(
      sql`CASE WHEN ${documents.estado} IN ('rechazado', 'error') THEN 1 ELSE 0 END`,
      desc(documents.createdAt),
    )
    .limit(1);
  return row ?? null;
};
