/**
 * Numeración service: secuencia de números de documento con lock transaccional.
 *
 * SIFEN rechaza documentos con número duplicado dentro de (establecimiento, punto,
 * tipoDocumento) — por eso este servicio DEBE correr dentro de una transacción
 * que también inserte el document row. Si la transacción falla, el número no se
 * incrementa, evitando gaps sistemáticos.
 *
 * Usa `SELECT ... FOR UPDATE` para serializar el incremento frente a requests
 * concurrentes. Postgres bloquea la fila hasta el COMMIT.
 *
 * Alternativas consideradas:
 *   - Secuencias nativas de Postgres (CREATE SEQUENCE) — no permiten reset
 *     por tenant/establecimiento/punto de forma limpia
 *   - Redis INCR — más rápido pero introduce otra fuente de verdad y hay
 *     que reconciliar al reiniciar
 *   - SELECT FOR UPDATE — simple, correcto, escala bien hasta miles de
 *     requests/segundo por tenant (el hot spot es el lock por fila)
 */
import { eq, and, sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { numeracion } from '../db/schema.js';

// Tipo genérico de transacción Drizzle — no exportamos el tipo postgres-js
// específico para no acoplar el service al driver.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tx = PgTransaction<any, any, any>;

export interface AsignarNumeroInput {
  tenantId: string;
  tipo: number; // 1=FE, 5=NC
  establecimiento: string;
  punto: string;
}

/**
 * Reserva el próximo número para un (tenant, tipo, establecimiento, punto).
 *
 * DEBE llamarse dentro de una transacción. El caller es responsable de
 * insertar el document row en la misma tx y hacer COMMIT. Si el caller
 * hace ROLLBACK, el número no se consume.
 *
 * Retorna el número como string zero-padded a 7 dígitos ("0000001") que
 * es el formato que espera `xmlgen.generateXMLDE`.
 */
export const asignarSiguienteNumero = async (
  tx: Tx,
  input: AsignarNumeroInput,
): Promise<string> => {
  const filters = and(
    eq(numeracion.tenantId, input.tenantId),
    eq(numeracion.tipo, input.tipo),
    eq(numeracion.establecimiento, input.establecimiento),
    eq(numeracion.punto, input.punto),
  );

  // SELECT ... FOR UPDATE — bloquea la fila si existe
  const rows = await tx.execute(sql`
    SELECT ultimo_numero FROM numeracion
    WHERE tenant_id = ${input.tenantId}
      AND tipo = ${input.tipo}
      AND establecimiento = ${input.establecimiento}
      AND punto = ${input.punto}
    FOR UPDATE
  `);

  const rowArray = rows as unknown as Array<{ ultimo_numero: number | string }>;

  let nextNumber: number;
  if (rowArray.length === 0) {
    // Primera vez: insertar fila con 1
    await tx
      .insert(numeracion)
      .values({
        tenantId: input.tenantId,
        tipo: input.tipo,
        establecimiento: input.establecimiento,
        punto: input.punto,
        ultimoNumero: 1,
      });
    nextNumber = 1;
  } else {
    const current = Number(rowArray[0].ultimo_numero);
    nextNumber = current + 1;
    await tx
      .update(numeracion)
      .set({ ultimoNumero: nextNumber, updatedAt: new Date() })
      .where(filters);
  }

  return String(nextNumber).padStart(7, '0');
};

/**
 * Consulta el último número asignado (sin lock). Útil para UI/reportes.
 */
export const consultarUltimoNumero = async (
  tx: Tx,
  input: AsignarNumeroInput,
): Promise<number> => {
  const [row] = await tx
    .select({ ultimoNumero: numeracion.ultimoNumero })
    .from(numeracion)
    .where(
      and(
        eq(numeracion.tenantId, input.tenantId),
        eq(numeracion.tipo, input.tipo),
        eq(numeracion.establecimiento, input.establecimiento),
        eq(numeracion.punto, input.punto),
      ),
    )
    .limit(1);
  return row ? Number(row.ultimoNumero) : 0;
};
