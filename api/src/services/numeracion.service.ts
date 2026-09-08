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
import { db } from '../db/index.js';
import { numeracion, documents } from '../db/schema.js';
import { ConflictError } from '../lib/errors.js';

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
 * Modo "numeración del tenant": el cliente mandó `numero` explícito en la
 * emisión. Sincroniza la secuencia interna hacia ARRIBA (GREATEST) para que
 * el modo automático siga coherente si se mezclan modos — nunca retrocede.
 * DEBE correr dentro de la misma transacción que el insert del documento.
 */
export const registrarNumeroExplicito = async (
  tx: Tx,
  input: AsignarNumeroInput & { numero: number },
): Promise<void> => {
  await tx.execute(sql`
    INSERT INTO numeracion (tenant_id, tipo, establecimiento, punto, ultimo_numero)
    VALUES (${input.tenantId}, ${input.tipo}, ${input.establecimiento}, ${input.punto}, ${input.numero})
    ON CONFLICT (tenant_id, tipo, establecimiento, punto)
    DO UPDATE SET ultimo_numero = GREATEST(numeracion.ultimo_numero, ${input.numero}),
                  updated_at = now()
  `);
};

/**
 * Setea el correlativo de un (tenant, tipo, establecimiento, punto) —
 * onboarding de clientes que migran desde otro sistema de facturación con
 * numeración ya avanzada (ej. Balloon Party llegó emitiendo por otro
 * proveedor y su próximo número era 612: ultimoNumero=611).
 *
 * `ultimoNumero` = último número YA usado; el próximo emitido será +1.
 *
 * Guard anti-colisión: no se permite retroceder por debajo del mayor número
 * ACTIVO ya emitido en ese scope (docs rechazado/error no cuentan — su
 * número es fiscalmente reutilizable, ver índice parcial en schema).
 */
export const setNumeracion = async (input: {
  tenantId: string;
  tipo: number;
  establecimiento: string;
  punto: string;
  ultimoNumero: number;
}): Promise<{ ultimoNumero: number; proximoNumero: number }> => {
  const [maxRow] = await db
    .select({ max: sql<string>`COALESCE(MAX(${documents.numero}::int), 0)` })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, input.tenantId),
        eq(documents.tipo, input.tipo),
        eq(documents.establecimiento, input.establecimiento),
        eq(documents.punto, input.punto),
        sql`${documents.estado} NOT IN ('rechazado', 'error')`,
      ),
    );
  const maxActivo = Number(maxRow?.max ?? 0);
  if (input.ultimoNumero < maxActivo) {
    throw new ConflictError(
      `ultimoNumero=${input.ultimoNumero} es menor que el mayor número activo ya emitido (${maxActivo}) — colisionaría en la próxima emisión`,
    );
  }

  await db
    .insert(numeracion)
    .values({
      tenantId: input.tenantId,
      tipo: input.tipo,
      establecimiento: input.establecimiento,
      punto: input.punto,
      ultimoNumero: input.ultimoNumero,
    })
    .onConflictDoUpdate({
      target: [numeracion.tenantId, numeracion.tipo, numeracion.establecimiento, numeracion.punto],
      set: { ultimoNumero: input.ultimoNumero, updatedAt: new Date() },
    });

  return { ultimoNumero: input.ultimoNumero, proximoNumero: input.ultimoNumero + 1 };
};

/**
 * Lista la numeración vigente de un tenant (todas las secuencias).
 */
export const listNumeracion = async (tenantId: string) => {
  const rows = await db
    .select({
      tipo: numeracion.tipo,
      establecimiento: numeracion.establecimiento,
      punto: numeracion.punto,
      ultimoNumero: numeracion.ultimoNumero,
      updatedAt: numeracion.updatedAt,
    })
    .from(numeracion)
    .where(eq(numeracion.tenantId, tenantId));
  return rows.map((r) => ({
    tipoDocumento: r.tipo,
    establecimiento: r.establecimiento,
    punto: r.punto,
    ultimoNumero: Number(r.ultimoNumero),
    proximoNumero: Number(r.ultimoNumero) + 1,
    updatedAt: r.updatedAt.toISOString(),
  }));
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
