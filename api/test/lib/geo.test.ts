/**
 * Catálogo geográfico: derivación ciudad → distrito → departamento.
 *
 * SIFEN rechaza el documento si el trío no es coherente, así que la
 * derivación tiene que salir de la misma tabla que usa el motor.
 */
import { describe, it, expect } from 'vitest';
import {
  resolverCiudad,
  completarUbicacion,
  buscarCiudades,
  listarDepartamentos,
} from '../../src/lib/geo.js';

describe('resolverCiudad', () => {
  it('resuelve la jerarquía completa de Asunción', () => {
    const u = resolverCiudad(1)!;
    expect(u.ciudadDescripcion).toContain('ASUNCION');
    expect(u.distrito).toBe(1);
    expect(u.departamento).toBe(1);
    expect(u.departamentoDescripcion).toBeTruthy();
  });

  it('devuelve null para un código inexistente', () => {
    expect(resolverCiudad(999999)).toBeNull();
  });
});

describe('completarUbicacion', () => {
  it('rellena distrito y departamento a partir de la ciudad', () => {
    const cliente: Record<string, unknown> = { direccion: 'Av. España', ciudad: 1 };
    completarUbicacion(cliente);
    expect(cliente.distrito).toBe(1);
    expect(cliente.departamento).toBe(1);
    expect(cliente.ciudadDescripcion).toBeTruthy();
  });

  it('respeta los códigos que ya mandó el integrador', () => {
    const cliente: Record<string, unknown> = { ciudad: 1, distrito: 7, departamento: 3 };
    completarUbicacion(cliente);
    expect(cliente.distrito).toBe(7);
    expect(cliente.departamento).toBe(3);
  });

  it('no rompe con undefined, null o sin ciudad', () => {
    expect(() => completarUbicacion(undefined)).not.toThrow();
    expect(() => completarUbicacion(null)).not.toThrow();
    const sinCiudad: Record<string, unknown> = { direccion: 'x' };
    completarUbicacion(sinCiudad);
    expect(sinCiudad.distrito).toBeUndefined();
  });
});

describe('buscarCiudades', () => {
  it('encuentra Ciudad del Este y trae su departamento', () => {
    const [primera] = buscarCiudades('ciudad del este');
    expect(primera.ciudadDescripcion).toContain('CIUDAD DEL ESTE');
    expect(primera.departamentoDescripcion).toContain('ALTO PARANA');
  });

  it('ignora acentos y mayúsculas', () => {
    expect(buscarCiudades('asunción').length).toBeGreaterThan(0);
  });

  it('respeta el límite y no explota con términos vacíos', () => {
    expect(buscarCiudades('san', 5)).toHaveLength(5);
    expect(buscarCiudades('')).toEqual([]);
  });
});

describe('listarDepartamentos', () => {
  it('devuelve los 18 departamentos ordenados por código', () => {
    const deps = listarDepartamentos();
    expect(deps).toHaveLength(18);
    expect(deps[0].codigo).toBeLessThan(deps[17].codigo);
  });
});
