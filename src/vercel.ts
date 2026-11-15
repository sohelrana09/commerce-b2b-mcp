import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, type Config } from "./config.js";
import { createHttpApp } from "./http/app.js";
import { SERVER_NAME, SERVER_VERSION } from "./server.js";

/**
 * Vercel entry (ADR 21). `api/index.js` re-exports the default handler; every
 * path is rewritten to it by `vercel.json`. The app is built on the first
 * request and reused while the function instance stays warm.
 */

const log = (msg: string) => process.stderr.write(`[${SERVER_NAME} ${SERVER_VERSION}] ${msg}\n`);

/** Shown to callers when the deployment is misconfigured. The details go to the function logs only. */
export const NOT_CONFIGURED = "This server is not configured correctly. The deployment's function logs say why.";

/**
 * Load the config for a serverless function. Instances come and go and share
 * nothing in memory, so sign-in state must live in Redis and every request must
 * stand alone: anything else signs users out at random.
 */
export function serverlessConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = loadConfig({ ...env, COMMERCE_TRANSPORT: env.COMMERCE_TRANSPORT ?? "http" });
  const http = config.http;
  if (!http) throw new Error("COMMERCE_TRANSPORT must be http on Vercel.");
  if (http.sessions !== "stateless") {
    throw new Error("Set COMMERCE_HTTP_SESSIONS=stateless on Vercel: MCP sessions cannot follow a request to another function instance.");
  }
  if (http.state.kind !== "redis") {
    throw new Error("Set COMMERCE_STATE_STORE=redis (with COMMERCE_REDIS_URL and COMMERCE_STATE_KEY) on Vercel: sign-ins kept in one instance's memory are lost on the next.");
  }
  if (http.publicUrl.protocol !== "https:") {
    throw new Error("Set COMMERCE_PUBLIC_URL to the deployment's https production domain, e.g. https://my-project.vercel.app");
  }
  return config;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type App = (req: IncomingMessage, res: ServerResponse) => void;

export interface VercelHandlerOptions {
  /** Builds the app from the checked config. Tests pass one with an in-memory store. */
  build?: (config: Config) => { app: App; ready: () => Promise<void> };
  /** Config checks. Tests relax the https and Redis rules to run locally. */
  configure?: (env: NodeJS.ProcessEnv) => Config;
}

export function createVercelHandler(env: NodeJS.ProcessEnv = process.env, opts: VercelHandlerOptions = {}): Handler {
  const build = opts.build ?? ((config: Config) => createHttpApp(config));
  const configure = opts.configure ?? serverlessConfig;
  let pending: Promise<App> | undefined;

  const start = async (): Promise<App> => {
    const config = configure(env);
    const built = build(config);
    await built.ready();
    log(`vercel handler ready, backend=${config.backend}, MCP endpoint ${new URL("/mcp", config.http!.publicUrl).href}`);
    return built.app;
  };

  return async (req, res) => {
    let app: App;
    try {
      pending ??= start();
      app = await pending;
    } catch (err) {
      // Build again on the next request, so a Redis blip or a fixed setting recovers without a redeploy.
      pending = undefined;
      log(`not started: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.statusCode = 503;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.setHeader("retry-after", "30");
      }
      res.end(NOT_CONFIGURED);
      return;
    }
    app(req, res);
  };
}

export default createVercelHandler();
