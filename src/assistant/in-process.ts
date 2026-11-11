import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memoryAuditSink } from "../audit.js";
import { loadConfig } from "../config.js";
import { createServer } from "../server.js";
import { connectTransport, type CommerceTools } from "./commerce.js";

/**
 * The MCP server in this process against the mock store, connected through an
 * in-memory transport. Used by the eval and the demo: nothing is spawned, no
 * credentials are needed, and the audit log stays in memory.
 */
export async function inProcessTools(callerEmail = "sam.purchasing@harbour.example"): Promise<CommerceTools> {
  const config = loadConfig({ COMMERCE_BACKEND: "mock", COMMERCE_CALLER_EMAIL: callerEmail, COMMERCE_CONFIRM_SECRET: "in-process-mock-only-secret" });
  const { server } = createServer(config, { audit: memoryAuditSink() });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  return connectTransport(clientT);
}
