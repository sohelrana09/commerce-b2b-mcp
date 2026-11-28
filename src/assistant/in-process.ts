import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memoryAuditSink, type AuditSink } from "../audit.js";
import type { CommerceBackend } from "../backend/types.js";
import { loadConfig, type Config } from "../config.js";
import type { TokenLedger } from "../confirm.js";
import { createServer } from "../server.js";
import { connectTransport, type CommerceTools } from "./commerce.js";

export interface ToolsForOptions {
  config: Config;
  callerEmail: string;
  backend?: CommerceBackend;
  audit?: AuditSink;
  ledger?: TokenLedger;
}

/**
 * An MCP server in this process, acting as `callerEmail`, connected through an in-memory transport.
 * Server-side code (the review_rfq tool, the web page, the inbox) runs the quote pipeline through it,
 * so it gets the same caller scoping, allowlist, audit log and propose-then-approve writes as any client.
 */
export async function toolsFor(opts: ToolsForOptions): Promise<CommerceTools> {
  const { server } = createServer(
    { ...opts.config, callerEmail: opts.callerEmail },
    {
      ...(opts.backend ? { backend: opts.backend } : {}),
      ...(opts.audit ? { audit: opts.audit } : {}),
      ...(opts.ledger ? { ledger: opts.ledger } : {}),
    },
  );
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const tools = await connectTransport(clientT);
  return {
    call: tools.call,
    async close() {
      await tools.close();
      await server.close();
    },
  };
}

/**
 * The mock store as a Harbour Marine Engineering buyer. Used by the eval and the demo: nothing is spawned,
 * no credentials are needed, and the audit log stays in memory.
 */
export async function inProcessTools(callerEmail = "sam.purchasing@harbour.example"): Promise<CommerceTools> {
  const config = loadConfig({ COMMERCE_BACKEND: "mock", COMMERCE_CALLER_EMAIL: callerEmail, COMMERCE_CONFIRM_SECRET: "in-process-mock-only-secret" });
  return toolsFor({ config, callerEmail, audit: memoryAuditSink() });
}
