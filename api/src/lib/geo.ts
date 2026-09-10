/**
 * Códigos geográficos de SIFEN (departamento / distrito / ciudad).
 *
 * SIFEN exige los tres códigos en la dirección del receptor, pero son
 * jerárquicos: la ciudad determina el distrito y el distrito determina el
 * departamento. Pedirle los tres al integrador es pedirle que replique una
 * tabla que ya tenemos — y que se equivoque (un departamento que no
 * corresponde a la ciudad hace rebotar el documento en SIFEN).
 *
 * Las tablas son las que ya viajan dentro de xmlgen, así que no
 * introducimos una segunda fuente de verdad: si el motor se actualiza,
 * esto se actualiza con él.
 *
 * xmlgen ya deriva distrito/departamento para `detalleTransporte.salida` y
 * `.entrega`, pero NO para `cliente` — esa asimetría es la que corregimos
 * acá, aplicándolo de forma uniforme a las tres.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const constantes = require('facturacionelectronicapy-xmlgen/dist/services/constants.service.js').default;

interface Ciudad { codigo: number; descripcion: string; distrito: number }
interface Distrito { codigo: number; descripcion: string; departamento: number }
interface Departamento { codigo: number; descripcion: string }

const ciudades: Ciudad[] = constantes.ciudades;
const distritos: Distrito[] = constantes.distritos;
const departamentos: Departamento[] = constantes.departamentos;

const ciudadPorCodigo = new Map(ciudades.map((c) => [c.codigo, c]));
const distritoPorCodigo = new Map(distritos.map((d) => [d.codigo, d]));
const departamentoPorCodigo = new Map(departamentos.map((d) => [d.codigo, d]));

export interface UbicacionResuelta {
  ciudad: number;
  ciudadDescripcion: string;
  distrito: number;
  distritoDescripcion: string;
  departamento: number;
  departamentoDescripcion: string;
}

/** Resuelve la jerarquía completa a partir del código de ciudad. */
export const resolverCiudad = (codigoCiudad: number): UbicacionResuelta | null => {
  const ciudad = ciudadPorCodigo.get(Number(codigoCiudad));
  if (!ciudad) return null;
  const distrito = distritoPorCodigo.get(ciudad.distrito);
  if (!distrito) return null;
  const departamento = departamentoPorCodigo.get(distrito.departamento);
  if (!departamento) return null;
  return {
    ciudad: ciudad.codigo,
    ciudadDescripcion: ciudad.descripcion,
    distrito: distrito.codigo,
    distritoDescripcion: distrito.descripcion,
    departamento: departamento.codigo,
    departamentoDescripcion: departamento.descripcion,
  };
};

/**
 * Completa distrito/departamento (y sus descripciones) en un objeto de
 * dirección que ya trae `ciudad`. Muta en el lugar y solo rellena lo que
 * falta: si el integrador mandó los tres códigos, respetamos los suyos.
 *
 * No valida coherencia — de eso se encarga xmlgen, que ya emite un error
 * legible si el trío no corresponde.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const completarUbicacion = (direccion: Record<string, any> | undefined | null): void => {
  if (!direccion || typeof direccion !== 'object') return;
  if (direccion.ciudad == null) return;
  const resuelta = resolverCiudad(Number(direccion.ciudad));
  if (!resuelta) return;
  if (direccion.distrito == null) direccion.distrito = resuelta.distrito;
  if (direccion.departamento == null) direccion.departamento = resuelta.departamento;
  if (!direccion.ciudadDescripcion) direccion.ciudadDescripcion = resuelta.ciudadDescripcion;
  if (!direccion.distritoDescripcion) direccion.distritoDescripcion = resuelta.distritoDescripcion;
  if (!direccion.departamentoDescripcion) {
    direccion.departamentoDescripcion = resuelta.departamentoDescripcion;
  }
};

/** Normaliza para búsqueda: sin acentos, minúsculas. */
const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/**
 * Busca ciudades por nombre. Prioriza las que EMPIEZAN con el término —
 * "san" debe traer "SAN LORENZO" antes que "VILLA SAN MIGUEL".
 */
export const buscarCiudades = (q: string, limit = 20): UbicacionResuelta[] => {
  const termino = norm(q);
  if (termino.length === 0) return [];
  const empiezan: Ciudad[] = [];
  const contienen: Ciudad[] = [];
  for (const ciudad of ciudades) {
    const nombre = norm(ciudad.descripcion);
    if (nombre.startsWith(termino)) empiezan.push(ciudad);
    else if (nombre.includes(termino)) contienen.push(ciudad);
    if (empiezan.length >= limit) break;
  }
  return [...empiezan, ...contienen]
    .slice(0, limit)
    .map((c) => resolverCiudad(c.codigo))
    .filter((u): u is UbicacionResuelta => u !== null);
};

/** Catálogo completo de departamentos (18 filas, cabe en una respuesta). */
export const listarDepartamentos = (): Departamento[] =>
  [...departamentos].sort((a, b) => a.codigo - b.codigo);
