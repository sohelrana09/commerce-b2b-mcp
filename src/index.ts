#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main() {
  const config = loadConfig();
  const { server, backend, tools } = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; all diagnostics go to stderr.
  process.stderr.write(
    `[${SERVER_NAME} ${SERVER_VERSION}] backend=${backend.name} caller=${config.callerEmail} tools=${tools.join(",")}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
