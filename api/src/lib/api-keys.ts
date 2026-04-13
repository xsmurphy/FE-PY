/**
 * Generación y verificación de API keys de companies.
 *
 * Formato: `cmp_<32-hex-chars>`  (ej. "cmp_a1b2c3d4e5f6...")
 *   - prefix identifica el tipo (cmp = company master key)
 *   - 16 bytes random = 128 bits de entropía
 *   - prefix de 10 chars se guarda en claro para búsqueda rápida
 *   - el hash completo (sha256) se guarda para verificación
 *
 * Por qué sha256 y no bcrypt:
 *   - Las API keys son high-entropy (128 bits), no necesitamos trabajo CPU
 *     extra para frenar brute force — es infeasible de entrada.
 *   - Necesitamos verificación O(1) en el auth middleware, no O(slow).
 *   - Esto es la práctica estándar (Stripe, GitHub PAT, etc. funcionan así).
 */
import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'cmp_';
const KEY_RAND_BYTES = 16;
const PREFIX_LENGTH = 10; // "cmp_a1b2c3" - suficiente para lookup, no revela la key

export interface GeneratedKey {
  /** Plaintext — SOLO se muestra una vez al cliente al crear/rotar */
  plaintext: string;
  /** Hash SHA-256 hex para guardar en DB */
  hash: string;
  /** Prefijo de 10 chars para búsqueda rápida */
  prefix: string;
}

export const generateApiKey = (): GeneratedKey => {
  const plaintext = KEY_PREFIX + randomBytes(KEY_RAND_BYTES).toString('hex');
  const hash = hashApiKey(plaintext);
  const prefix = plaintext.slice(0, PREFIX_LENGTH);
  return { plaintext, hash, prefix };
};

export const hashApiKey = (plaintext: string): string => {
  return createHash('sha256').update(plaintext).digest('hex');
};

export const extractPrefix = (plaintext: string): string => {
  return plaintext.slice(0, PREFIX_LENGTH);
};

/**
 * Verifica formato antes de tocar DB. Rechaza inputs obviamente inválidos.
 */
export const looksLikeApiKey = (input: string): boolean => {
  return input.startsWith(KEY_PREFIX) && input.length === KEY_PREFIX.length + KEY_RAND_BYTES * 2;
};
