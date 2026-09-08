#!/usr/bin/env node
/**
 * fepy-mcp — entry point standalone.
 *
 * Modo stdio (Claude Code / Claude Desktop local):
 *   FEPY_URL=... FEPY_API_KEY=cmp_... node server.mjs
 *
 * Modo HTTP standalone (opcional — en producción el MCP va EMBEBIDO en el
 * API Fastify bajo /mcp, no hace falta este modo):
 *   FEPY_URL=... MCP_HTTP_PORT=3100 node server.mjs
 *
 * Env opcionales: FEPY_TENANT_ID, FEPY_ESTABLECIMIENTO, FEPY_PUNTO.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { buildMcpServer } from './lib.mjs';

const BASE = process.env.FEPY_URL?.replace(/\/$/, '');
const ENV_API_KEY = process.env.FEPY_API_KEY;
const HTTP_PORT = process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : null;

if (!BASE) {
  console.error('[fepy-mcp] Falta FEPY_URL en el entorno');
  process.exit(1);
}
if (!HTTP_PORT && !ENV_API_KEY) {
  console.error('[fepy-mcp] En modo stdio se requiere FEPY_API_KEY');
  process.exit(1);
}

const requestContext = new AsyncLocalStorage();

const server = buildMcpServer({
  base: BASE,
  getApiKey: () => requestContext.getStore()?.apiKey ?? ENV_API_KEY,
  defaults: {
    tenant: process.env.FEPY_TENANT_ID,
    establecimiento: process.env.FEPY_ESTABLECIMIENTO,
    punto: process.env.FEPY_PUNTO,
  },
});

if (HTTP_PORT) {
  const httpServer = createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'fepy-mcp' }));
      return;
    }
    if (!req.url.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization;
    const pathKey = /^\/mcp\/(cmp_[0-9a-f]+)\/?$/.exec(req.url.split('?')[0])?.[1];
    const apiKey =
      (typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined) ?? pathKey;

    const chunks = [];
    for await (const c of req) chunks.push(c);
    let parsedBody;
    try {
      parsedBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    } catch {
      res.writeHead(400).end('invalid json');
      return;
    }

    await requestContext.run({ apiKey }, async () => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    });
  });
  httpServer.listen(HTTP_PORT, () => {
    console.error(`[fepy-mcp] HTTP en :${HTTP_PORT}/mcp — API: ${BASE} (auth por Bearer del cliente)`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[fepy-mcp] stdio conectado — API: ${BASE}`);
}
