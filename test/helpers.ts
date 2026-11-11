import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memoryAuditSink } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

export async function connect(env: Record<string, string> = {}) {
  const config = loadConfig({ COMMERCE_BACKEND: "mock", COMMERCE_CONFIRM_SECRET: "test-secret", ...env });
  const audit = memoryAuditSink();
  const { server } = createServer(config, { audit });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    return { isError: Boolean(res.isError), data: JSON.parse(content[0]!.text) };
  };
  return { client, call, audit, config };
}
