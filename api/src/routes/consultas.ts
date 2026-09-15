/**
 * Rutas de consulta a SIFEN.
 *
 * Consultas read-only que no modifican estado — usan setapi para pegarle
 * directamente a SIFEN con el cert de un tenant.
 *
 * Diseño: la ruta es tenant-scoped para que el cert a usar sea explícito.
 * Una company con múltiples tenants puede elegir con cuál autenticar la
 * consulta. Esto evita ambigüedad de "qué cert usar para una consulta
 * que no está asociada a ningún tenant en particular".
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireTenantScope } from '../middleware/tenant-scope.js';
import { withTenantCertFile } from '../services/tenant-cert.js';
import { env } from '../config/env.js';
import { BadRequestError, ForbiddenError, SifenError } from '../lib/errors.js';
import { extractConsultaDe } from '../lib/sifen-response.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const setapi = require('facturacionelectronicapy-setapi').default;

export const consultaRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/consulta/ruc/:ruc
  //
  // Consulta información de un RUC en SIFEN. Requiere cert del tenant
  // scoper (cualquiera sirve — SIFEN solo necesita autenticar al emisor
  // que consulta, no al consultado).
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/consulta/ruc/:ruc',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['consultas'],
        summary: 'Consultar información de un RUC en SIFEN',
        description:
          'Usa setapi.consultaRUC con el certificado del tenant. Requiere ' +
          'ENABLE_SIFEN=true porque es una llamada real a SIFEN.',
        security: [{ bearerAuth: [] }],
        params: z.object({
          tenant_id: z.string().uuid(),
          ruc: z.string().min(5).max(20),
        }),
        response: {
          200: z.object({
            ruc: z.string(),
            response: z.unknown(),
          }),
        },
      },
    },
    async (request) => {
      if (!env.ENABLE_SIFEN) {
        throw new BadRequestError(
          'SIFEN integration is disabled (ENABLE_SIFEN=false). Set ENABLE_SIFEN=true to use this endpoint.',
        );
      }

      return withTenantCertFile(
        { companyId: request.company!.id, tenantId: request.tenant!.id, proposito: 'consulta-ruc' },
        async (certPath, password) => {
          try {
            const response = await setapi.consultaRUC(
              Number(Date.now() % 1_000_000),
              request.params.ruc,
              request.tenant!.env,
              certPath,
              password,
            );
            return {
              ruc: request.params.ruc,
              response: typeof response === 'string' ? { raw: response } : response,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new SifenError(`Error al consultar RUC: ${msg}`);
          }
        },
      );
    },
  );

  // ─────────────────────────────────────────────────────
  // GET /v1/tenants/:tenant_id/consulta/de/:cdc
  //
  // Consulta un DE en SIFEN por CDC aunque NO lo haya emitido FE-PY: devuelve
  // el XML que SIFEN tiene registrado y los datos del bloque de timbrado.
  //
  // Existe para migrar clientes desde otro sistema de facturación: número,
  // punto y serie (dSerieNum) vigentes solo se pueden leer del XML aprobado
  // en SIFEN (caso real: rechazo 1110 en Balloon Party 001-001, 2026-09-15,
  // porque el KUDE del otro sistema no imprimía la serie).
  //
  // Solo CDCs del RUC del propio tenant: el certificado del contribuyente no
  // se usa para leer documentos de terceros.
  // ─────────────────────────────────────────────────────
  app.get(
    '/tenants/:tenant_id/consulta/de/:cdc',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['consultas'],
        summary: 'Consultar en SIFEN un documento por CDC (aunque lo haya emitido otro sistema)',
        description:
          'Devuelve el veredicto de SIFEN, el bloque de timbrado del documento (establecimiento, ' +
          'punto, número, serie dSerieNum) y el XML registrado. Útil para migrar clientes desde ' +
          'otro sistema. Solo acepta CDCs del RUC del tenant.',
        security: [{ bearerAuth: [] }],
        params: z.object({
          tenant_id: z.string().uuid(),
          cdc: z.string().regex(/^\d{44}$/, 'El CDC tiene 44 dígitos'),
        }),
        response: {
          200: z.object({
            cdc: z.string(),
            encontrado: z.boolean(),
            codigoRespuesta: z.string().nullable(),
            mensaje: z.string().nullable(),
            timbrado: z
              .object({
                tipoDocumento: z.string().nullable(),
                timbrado: z.string().nullable(),
                establecimiento: z.string().nullable(),
                punto: z.string().nullable(),
                numero: z.string().nullable(),
                serie: z.string().nullable(),
                inicioVigencia: z.string().nullable(),
              })
              .nullable(),
            fechaEmision: z.string().nullable(),
            protocoloAutorizacion: z.string().nullable(),
            xml: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => {
      if (!env.ENABLE_SIFEN) {
        throw new BadRequestError('SIFEN integration is disabled (ENABLE_SIFEN=false).');
      }

      const { cdc } = request.params;
      // CDC: tipo(2) + RUC(8, con ceros a la izquierda) + DV(1) + …
      const [rucBase, dv] = request.tenant!.ruc.split('-');
      if (cdc.slice(2, 10) !== rucBase.padStart(8, '0') || cdc.slice(10, 11) !== dv) {
        throw new ForbiddenError('El CDC no corresponde al RUC de este tenant');
      }

      return withTenantCertFile(
        { companyId: request.company!.id, tenantId: request.tenant!.id, proposito: 'consulta-de' },
        async (certPath, password) => {
          let raw: Record<string, unknown>;
          try {
            const response = await setapi.consulta(
              Number(Date.now() % 1_000_000),
              cdc,
              request.tenant!.env,
              certPath,
              password,
            );
            raw = typeof response === 'string' ? { raw: response } : (response as Record<string, unknown>);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new SifenError(`Error al consultar SIFEN: ${msg}`);
          }

          const r = extractConsultaDe(raw);
          const t = r.timbrado;
          return {
            cdc,
            encontrado: r.encontrado,
            codigoRespuesta: r.codigo ?? null,
            mensaje: r.mensaje ?? null,
            timbrado: t
              ? {
                  tipoDocumento: t.tipoDocumento ?? null,
                  timbrado: t.timbrado ?? null,
                  establecimiento: t.establecimiento ?? null,
                  punto: t.punto ?? null,
                  numero: t.numero ?? null,
                  serie: t.serie,
                  inicioVigencia: t.inicioVigencia ?? null,
                }
              : null,
            fechaEmision: r.fechaEmision ?? null,
            protocoloAutorizacion: r.protocoloAutorizacion ?? null,
            xml: r.xml ?? null,
          };
        },
      );
    },
  );
};
