/**
 * Carga segura de credenciales fiscales por el propio contribuyente.
 *
 *   POST /v1/tenants/:tenant_id/setup-link   (auth del integrador)
 *        → genera un link de un solo uso para mandarle al contribuyente
 *
 *   GET  /setup/:token    → formulario HTML (el token ES la autenticación)
 *   POST /setup/:token    → recibe .p12 + password + CSC y quema el link
 *
 * El integrador —y cualquier agente IA que lo opere— nunca ve la contraseña
 * del certificado ni el CSC.
 */
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenantCerts } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenantScope } from '../middleware/tenant-scope.js';
import {
  createSetupLink,
  resolveSetupLink,
  markSetupLinkUsed,
  DEFAULT_TTL_MINUTES,
} from '../services/setup-link.service.js';
import {
  parseP12,
  assertCertNotExpired,
  assertRucMatches,
  encryptCertBundle,
} from '../services/cert.service.js';
import { setCsc } from '../services/csc.service.js';
import { BadRequestError } from '../lib/errors.js';
import { env } from '../config/env.js';

// ── Endpoint del integrador ────────────────────────────────────────
export const setupLinkRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/tenants/:tenant_id/setup-link',
    {
      preHandler: [requireAuth, requireTenantScope],
      schema: {
        tags: ['tenants'],
        summary: 'Generar link de un solo uso para que el contribuyente cargue cert + CSC',
        description:
          'Devuelve una URL temporal para enviarle al contribuyente. El .p12, su ' +
          'contraseña y el CSC se cargan ahí directamente: no pasan por el integrador.',
        security: [{ bearerAuth: [] }],
        params: z.object({ tenant_id: z.string().uuid() }),
        body: z
          .object({
            ttlMinutes: z.number().int().min(5).max(1440).optional()
              .describe(`Vigencia del link en minutos (default ${DEFAULT_TTL_MINUTES}, máx 1440)`),
          })
          .optional(),
        response: {
          201: z.object({
            url: z.string(),
            expiresAt: z.string(),
            instrucciones: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { token, expiresAt } = await createSetupLink({
        companyId: request.company!.id,
        tenantId: request.tenant!.id,
        ttlMinutes: request.body?.ttlMinutes,
      });
      // headers.host incluye el puerto (request.hostname lo omite en Fastify 5);
      // en producción conviene fijar PUBLIC_BASE_URL para no depender del proxy.
      const base =
        env.PUBLIC_BASE_URL?.replace(/\/$/, '') ??
        `${request.protocol}://${request.headers.host ?? request.hostname}`;
      return reply.status(201).send({
        url: `${base}/setup/${token}`,
        expiresAt: expiresAt.toISOString(),
        instrucciones:
          'Enviá este link al contribuyente por un canal directo. Es de un solo uso ' +
          'y expira. NO pidas la contraseña del certificado ni el CSC por chat.',
      });
    },
  );
};

// ── Formulario público (el token es la auth) ───────────────────────
const page = (body: string) => `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Configuración de facturación electrónica</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:34rem;margin:0 auto;padding:2rem 1.25rem;line-height:1.5}
h1{font-size:1.35rem;margin-bottom:.25rem}
.sub{color:#666;margin-top:0;font-size:.95rem}
label{display:block;margin-top:1.1rem;font-weight:600;font-size:.92rem}
input{width:100%;padding:.6rem;margin-top:.3rem;border:1px solid #8884;border-radius:.5rem;font-size:1rem;background:transparent;color:inherit;box-sizing:border-box}
button{margin-top:1.5rem;width:100%;padding:.75rem;border:0;border-radius:.5rem;background:#4f46e5;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
.hint{color:#666;font-size:.82rem;margin-top:.25rem}
.box{border:1px solid #8884;border-radius:.75rem;padding:1rem 1.25rem;margin-top:1.5rem}
.ok{color:#059669}.err{color:#dc2626}
</style></head><body>${body}</body></html>`;

export const registerSetupForm = (app: FastifyInstance): void => {
  app.get('/setup/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    let ctx;
    try {
      ctx = await resolveSetupLink(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Link inválido';
      return reply.type('text/html').status(400).send(
        page(`<h1>Link no disponible</h1><p class="err">${msg}</p>
        <p class="hint">Pedile a tu proveedor de facturación que te genere uno nuevo.</p>`),
      );
    }
    return reply.type('text/html').send(
      page(`<h1>Configuración de facturación electrónica</h1>
      <p class="sub">${ctx.razonSocial} — RUC ${ctx.ruc}</p>
      <div class="box">
        <form method="POST" enctype="multipart/form-data" action="/setup/${token}">
          <label>Certificado digital (.p12)
            <input type="file" name="file" accept=".p12,.pfx" required></label>
          <label>Contraseña del certificado
            <input type="password" name="password" required autocomplete="off"></label>
          <label>ID del CSC
            <input type="text" name="cscId" value="0001" required></label>
          <label>Código de Seguridad del Contribuyente (CSC)
            <input type="text" name="csc" required autocomplete="off"
              pattern="[A-Za-z0-9]{32}" title="32 caracteres alfanuméricos">
            <span class="hint">32 caracteres. Se obtiene en el portal eKuatia de la SET.</span></label>
          <button type="submit">Guardar credenciales</button>
        </form>
      </div>
      <p class="hint">Este link es de un solo uso y expira. Tus credenciales se guardan
      cifradas y no son visibles para nadie más.</p>`),
    );
  });

  app.post('/setup/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      const ctx = await resolveSetupLink(token);

      let p12Buffer: Buffer | null = null;
      let password: string | null = null;
      let cscId: string | null = null;
      let csc: string | null = null;

      for await (const part of (request as unknown as { parts: () => AsyncIterable<Record<string, unknown>> }).parts()) {
        const p = part as { type: string; fieldname: string; file?: AsyncIterable<Buffer>; value?: unknown };
        if (p.type === 'file' && p.fieldname === 'file' && p.file) {
          const chunks: Buffer[] = [];
          for await (const chunk of p.file) chunks.push(chunk as Buffer);
          p12Buffer = Buffer.concat(chunks);
        } else if (p.type === 'field') {
          if (p.fieldname === 'password') password = String(p.value);
          if (p.fieldname === 'cscId') cscId = String(p.value);
          if (p.fieldname === 'csc') csc = String(p.value);
        }
      }

      if (!p12Buffer?.length) throw new BadRequestError('Falta el archivo del certificado');
      if (!password) throw new BadRequestError('Falta la contraseña del certificado');
      if (!cscId || !csc) throw new BadRequestError('Falta el CSC');
      if (!/^[A-Za-z0-9]{32}$/.test(csc)) {
        throw new BadRequestError('El CSC debe tener exactamente 32 caracteres alfanuméricos');
      }

      // Certificado: parsear, validar contra el RUC del tenant, cifrar
      const parsed = parseP12(p12Buffer, password);
      assertCertNotExpired(parsed.metadata);
      assertRucMatches(parsed.metadata.subjectRuc, ctx.ruc);
      const bundle = encryptCertBundle(p12Buffer, password);
      p12Buffer.fill(0);
      p12Buffer = null;
      password = null;

      await db.delete(tenantCerts).where(eq(tenantCerts.tenantId, ctx.tenantId));
      await db.insert(tenantCerts).values({
        tenantId: ctx.tenantId,
        companyId: ctx.companyId,
        encryptedP12: bundle.p12.ciphertext,
        ivP12: bundle.p12.iv,
        tagP12: bundle.p12.tag,
        encryptedPassword: bundle.password.ciphertext,
        ivPassword: bundle.password.iv,
        tagPassword: bundle.password.tag,
        encryptedDek: bundle.dek.ciphertext,
        ivDek: bundle.dek.iv,
        tagDek: bundle.dek.tag,
        fingerprint: parsed.metadata.fingerprint,
        subjectCn: parsed.metadata.subjectCn,
        subjectRuc: parsed.metadata.subjectRuc,
        notBefore: parsed.metadata.notBefore,
        notAfter: parsed.metadata.notAfter,
      });

      await setCsc({ tenantId: ctx.tenantId, companyId: ctx.companyId, cscId, csc });
      await markSetupLinkUsed(ctx.id);

      request.log.info({ tenantId: ctx.tenantId }, 'Credenciales cargadas por setup link');

      return reply.type('text/html').send(
        page(`<h1>Listo ✓</h1>
        <p class="ok">Las credenciales de ${ctx.razonSocial} quedaron configuradas.</p>
        <p class="hint">Ya podés cerrar esta página. Este link no vuelve a funcionar.</p>`),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al guardar';
      return reply.type('text/html').status(400).send(
        page(`<h1>No se pudo guardar</h1><p class="err">${msg}</p>
        <p class="hint">Verificá el archivo y la contraseña, y volvé atrás para reintentar.</p>`),
      );
    }
  });
};
