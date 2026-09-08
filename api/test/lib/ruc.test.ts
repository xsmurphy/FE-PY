import { describe, it, expect } from 'vitest';
import { calcularDvRuc, validarRuc, normalizarRuc } from '../../src/lib/ruc.js';

describe('RUC paraguayo — dígito verificador módulo 11', () => {
  // RUCs REALES verificados contra el padrón (2026-09-07/08)
  it('calcula el DV de RUCs reales', () => {
    expect(calcularDvRuc('3595193')).toBe(1); // GONZALEZ QUEVEDO, CINTIA
    expect(calcularDvRuc('7659394')).toBe(0); // MURPHY, CHRISTIAN
    expect(calcularDvRuc('80069563')).toBe(1); // TIPS SA (ejemplo del motor)
  });

  it('acepta RUCs válidos', () => {
    expect(validarRuc('3595193-1').valid).toBe(true);
    expect(validarRuc('7659394-0').valid).toBe(true);
    expect(validarRuc(' 80069563-1 ').valid).toBe(true); // tolera espacios
  });

  it('rechaza DV incorrecto con mensaje accionable', () => {
    const r = validarRuc('3595193-5');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('el DV de 3595193 es 1');
  });

  it('rechaza formatos inválidos', () => {
    expect(validarRuc('3595193').valid).toBe(false); // sin DV
    expect(validarRuc('3595193-12').valid).toBe(false); // DV de 2 dígitos
    expect(validarRuc('abc-1').valid).toBe(false);
    expect(validarRuc('').valid).toBe(false);
  });

  it('normaliza: sin DV lo calcula y añade', () => {
    expect(normalizarRuc('3595193')).toEqual({ ruc: '3595193-1' });
    expect(normalizarRuc('7659394')).toEqual({ ruc: '7659394-0' });
    expect(normalizarRuc(' 80069563 ')).toEqual({ ruc: '80069563-1' });
  });

  it('normaliza: con DV correcto lo deja, con DV incorrecto rebota', () => {
    expect(normalizarRuc('3595193-1')).toEqual({ ruc: '3595193-1' });
    expect(normalizarRuc('3595193-7').error).toContain('el DV de 3595193 es 1');
    expect(normalizarRuc('abc').error).toBeDefined();
  });
});
