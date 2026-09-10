/**
 * Catálogo geográfico de SIFEN.
 *
 * Existe porque la dirección del receptor (y la de salida/entrega de una
 * Nota de Remisión) se informa con CÓDIGOS, no con nombres. Sin este
 * endpoint el integrador tiene que hardcodear una tabla de 6.766 ciudades
 * o adivinar — y un código equivocado se descubre recién cuando SIFEN
 * rechaza el documento.
 *
 * Solo lectura y sin datos de nadie: alcanza con estar autenticado, no
 * hace falta scope de tenant.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { buscarCiudades, resolverCiudad, listarDepartamentos } from '../lib/geo.js';
import { NotFoundError } from '../lib/errors.js';

const ubicacionSchema = z.object({
  ciudad: z.number().int(),
  ciudadDescripcion: z.string(),
  distrito: z.number().int(),
  distritoDescripcion: z.string(),
  departamento: z.number().int(),
  departamentoDescripcion: z.string(),
});

export const geoRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─────────────────────────────────────────────────────
  // GET /v1/geo/ciudades?q=ciudad+del+este
  // ─────────────────────────────────────────────────────
  app.get(
    '/geo/ciudades',
    {
      preHandler: [requireAuth],
      schema: {
        tags: ['geo'],
        summary: 'Buscar ciudades por nombre (devuelve distrito y departamento)',
        description:
          'Devuelve el trío ciudad/distrito/departamento que exige SIFEN. ' +
          'Al emitir alcanza con enviar `ciudad`: el API deriva los otros dos.',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          q: z.string().min(2).describe('Parte del nombre de la ciudad'),
          limit: z.coerce.number().int().positive().max(100).default(20),
        }),
        response: { 200: z.object({ ciudades: z.array(ubicacionSchema) }) },
      },
    },
    async (request) => ({ ciudades: buscarCiudades(request.query.q, request.query.limit) }),
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/geo/ciudades/:codigo
  // ─────────────────────────────────────────────────────
  app.get(
    '/geo/ciudades/:codigo',
    {
      preHandler: [requireAuth],
      schema: {
        tags: ['geo'],
        summary: 'Resolver un código de ciudad a su distrito y departamento',
        security: [{ bearerAuth: [] }],
        params: z.object({ codigo: z.coerce.number().int().positive() }),
        response: { 200: ubicacionSchema },
      },
    },
    async (request) => {
      const ubicacion = resolverCiudad(request.params.codigo);
      if (!ubicacion) throw new NotFoundError(`Ciudad con código ${request.params.codigo}`);
      return ubicacion;
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/geo/departamentos
  // ─────────────────────────────────────────────────────
  app.get(
    '/geo/departamentos',
    {
      preHandler: [requireAuth],
      schema: {
        tags: ['geo'],
        summary: 'Listar los 18 departamentos del país',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            departamentos: z.array(z.object({ codigo: z.number().int(), descripcion: z.string() })),
          }),
        },
      },
    },
    async () => ({ departamentos: listarDepartamentos() }),
  );
};
