/**
 * Validación del RUC paraguayo: formato "base-dv" y dígito verificador
 * (algoritmo módulo 11 de la SET/DNIT).
 *
 * Verificado contra RUCs reales: 3595193-1, 7659394-0, 80069563-1.
 */

export const calcularDvRuc = (base: string): number => {
  let k = 2;
  let total = 0;
  for (let i = base.length - 1; i >= 0; i--) {
    if (k > 11) k = 2;
    total += Number(base[i]) * k++;
  }
  const resto = total % 11;
  return resto > 1 ? 11 - resto : 0;
};

export interface RucValidation {
  valid: boolean;
  error?: string;
}

export interface RucNormalization {
  ruc?: string;
  error?: string;
}

/**
 * Normaliza un RUC de entrada:
 *   - "3595193"   → "3595193-1" (calcula y añade el DV)
 *   - "3595193-1" → "3595193-1" (valida el DV; error si no coincide)
 *   - inválido    → error accionable
 */
export const normalizarRuc = (input: string): RucNormalization => {
  const raw = input.trim();
  if (/^\d{1,8}$/.test(raw)) {
    return { ruc: `${raw}-${calcularDvRuc(raw)}` };
  }
  const check = validarRuc(raw);
  if (!check.valid) return { error: check.error };
  return { ruc: raw };
};

/** Valida formato "1234567-1" y que el DV sea el correcto. */
export const validarRuc = (ruc: string): RucValidation => {
  const match = /^(\d{1,8})-(\d)$/.exec(ruc.trim());
  if (!match) {
    return {
      valid: false,
      error: `RUC "${ruc}" no tiene formato válido — se espera "base-dv" (ej: 3595193-1)`,
    };
  }
  const [, base, dv] = match;
  const dvCalculado = calcularDvRuc(base);
  if (Number(dv) !== dvCalculado) {
    return {
      valid: false,
      error: `Dígito verificador del RUC incorrecto: "${ruc}" — el DV de ${base} es ${dvCalculado}`,
    };
  }
  return { valid: true };
};
