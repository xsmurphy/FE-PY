/**
 * MCP embebido: expone el servidor MCP de FE-PY (fepy-mcp/lib) en /mcp,
 * dentro del MISMO proceso Fastify — sin app ni dominio aparte:
 * https://fepy.punto.la/mcp queda servido por esta misma app.
 *
 * Transporte: Streamable HTTP stateless (un transport por request, sin
 * sesiones). Auth por request: header `Authorization: Bearer cmp_...`
 * (claude.ai Connectors lo soporta) o la key en el path /mcp/cmp_... como
 * fallback para clientes sin headers custom.
 *
 * Las tools llaman al propio API por HTTP loopback (127.0.0.1:PORT) — pasan
 * por las mismas rutas, auth, validaciones y audit log que cualquier
 * cliente externo. Cero atajos.
 */
import type { FastifyInstance } from 'fastify';
import { buildMcpServer } from 'fepy-mcp/lib';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { env } from '../config/env.js';

const extractApiKey = (authHeader: unknown, pathKey?: string): string | undefined => {
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return pathKey;
};

export const registerMcp = (app: FastifyInstance): void => {
  const base = `http://127.0.0.1:${env.PORT}`;

  const handle = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reply: any,
    apiKey: string | undefined,
  ) => {
    // Server nuevo por request (stateless): el getApiKey captura la key de
    // ESTE request — sin estado compartido entre clientes.
    const server = buildMcpServer({ base, getApiKey: () => apiKey });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };

  for (const path of ['/mcp', '/mcp/:key']) {
    app.route({
      method: ['POST', 'GET', 'DELETE'],
      url: path,
      config: { rateLimit: false },
      handler: async (request, reply) => {
        const pathKey = (request.params as { key?: string }).key;
        const apiKey = extractApiKey(request.headers.authorization, pathKey);
        await handle(request, reply, apiKey);
      },
    });
  }
};
