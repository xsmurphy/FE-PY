declare module 'fepy-mcp/lib' {
  import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
  export function buildMcpServer(opts: {
    base: string;
    getApiKey: () => string | undefined;
    defaults?: { tenant?: string; establecimiento?: string; punto?: string };
  }): McpServer;
}
