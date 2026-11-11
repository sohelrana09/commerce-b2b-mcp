#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./config.js";
import { createHttpApp } from "./http/app.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const log = (msg: string) => process.stderr.write(`[${SERVER_NAME} ${SERVER_VERSION}] ${msg}\n`);

async function stdio(config: Config) {
  const { server, backend, tools } = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; all diagnostics go to stderr.
  log(`stdio backend=${backend.name} caller=${config.callerEmail} tools=${tools.join(",")}`);
}

function http(config: Config) {
  const h = config.http!;
  const { app, mcpUrl, close } = createHttpApp(config);
  const listener = app.listen(h.port, h.host, () => {
    log(`http backend=${config.backend} listening on ${h.host}:${h.port}, MCP endpoint ${mcpUrl.href}, callers sign in with OAuth`);
  });
  const stop = () => {
    void close().finally(() => listener.close(() => process.exit(0)));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function main() {
  if (process.argv[2] === "demo") {
    const { runDemo } = await import("./demo.js");
    return runDemo(process.argv.slice(3));
  }
  const config = loadConfig();
  if (config.transport === "http") http(config);
  else await stdio(config);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
