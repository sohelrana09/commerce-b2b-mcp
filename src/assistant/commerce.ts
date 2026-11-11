import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * The quote assistant talks to Adobe Commerce only through the
 * commerce-b2b-mcp tools, exactly as any other MCP client would. It holds no
 * store credentials of its own and inherits the server's caller scoping,
 * allowlist, audit log and propose-then-approve writes.
 */
export interface ToolResult<T = any> {
  isError: boolean;
  data: T;
}

export interface CommerceTools {
  call<T = any>(name: string, args?: Record<string, unknown>): Promise<ToolResult<T>>;
  close(): Promise<void>;
}

export async function connectTransport(transport: Transport): Promise<CommerceTools> {
  const client = new Client({ name: "rfq-quote-assistant", version: "0.1.0" });
  await client.connect(transport);
  return {
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const block = (res.content as Array<{ type: string; text?: string }>)[0];
      const text = block?.text ?? "";
      try {
        return { isError: Boolean(res.isError), data: text ? JSON.parse(text) : null };
      } catch {
        // Input-validation failures come back as plain text, not the server's JSON error shape.
        return { isError: true, data: { error: { code: "INVALID_INPUT", message: text } } };
      }
    },
    close: () => client.close(),
  };
}

/** Start the MCP server as a child process (the built dist/index.js, or a launcher script) and connect over stdio. */
export function connectStdio(serverEntry: string, env: Record<string, string | undefined>): Promise<CommerceTools> {
  const clean = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter((e): e is [string, string] => e[1] !== undefined));
  // A .js entry runs under this Node; anything else (e.g. a launcher script that loads store settings) runs as is.
  const js = /\.[cm]?js$/.test(serverEntry);
  return connectTransport(
    new StdioClientTransport({ command: js ? process.execPath : serverEntry, args: js ? [serverEntry] : [], env: clean, stderr: "pipe" }),
  );
}
