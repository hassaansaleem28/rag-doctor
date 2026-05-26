import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let cachedClient: Client | null = null;

export async function getCoralClient(): Promise<Client> {
  if (cachedClient) return cachedClient;

  const transport = new StdioClientTransport({
    command: 'coral',
    args: ['mcp-stdio'],
  });

  const client = new Client(
    { name: 'rag-doctor', version: '0.1.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  cachedClient = client;
  return client;
}

export async function getCoralTools() {
  const client = await getCoralClient();
  const result = await client.listTools();
  return result.tools;
}

export async function callCoralTool(name: string, args: Record<string, unknown>) {
  const client = await getCoralClient();
  const result = await client.callTool({ name, arguments: args });
  return result;
}
