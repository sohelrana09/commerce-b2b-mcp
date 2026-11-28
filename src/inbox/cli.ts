#!/usr/bin/env node
import { parseArgs } from "node:util";
import { toolsFor } from "../assistant/in-process.js";
import { createAuditSink } from "../audit.js";
import { loadConfig, loadInbox, loadState } from "../config.js";
import { memoryLedger } from "../confirm.js";
import { RedisStore } from "../http/state.js";
import { createBackend } from "../server.js";
import { openImapMailbox } from "./mailbox.js";
import { pollOnce } from "./poller.js";

const USAGE = `rfq-inbox: review RFQs that arrive by email and put them in the web page's queue.

  rfq-inbox [--once]

Reads unread mail over IMAP (TLS) as COMMERCE_INBOX_USER, reviews each RFQ as the company user
COMMERCE_CALLER_EMAIL, and saves it to that user's queue in the shared Redis store. It never drafts
or sends a quote: a person does that on the review page (COMMERCE_RFQ_WEB=on).

Needs the same COMMERCE_STATE_STORE=redis, COMMERCE_REDIS_URL and COMMERCE_STATE_KEY as the HTTP server,
the store settings for one company user (as for stdio), and COMMERCE_INBOX_*.`;

const log = (l: string) => process.stderr.write(`[rfq-inbox] ${l}\n`);

async function main() {
  const { values } = parseArgs({ options: { once: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } } });
  if (values.help) return void console.log(USAGE);
  if (process.env.COMMERCE_TRANSPORT === "http") throw new Error("rfq-inbox acts as one company user; run it with its own settings, not the HTTP server's.");
  const config = loadConfig({ ...process.env, COMMERCE_TRANSPORT: "stdio" });
  const inbox = loadInbox(process.env);
  const state = loadState(process.env);
  if (state.kind !== "redis") throw new Error("Set COMMERCE_STATE_STORE=redis: the review page reads the queue from the same Redis.");
  if (!inbox.allowedSenders.length) log("WARNING COMMERCE_INBOX_ALLOWED_SENDERS is empty: mail from anyone will be reviewed.");
  if (config.rfq.extractor === "claude") log("Claude intake is on: each RFQ is a paid API call (about $0.08).");

  const store = new RedisStore({ url: state.url, secret: state.secret, prefix: state.prefix });
  await store.ready();
  const backend = createBackend(config);
  const audit = createAuditSink(config.auditLog, config.auditInput);
  const ledger = memoryLedger();
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));
  try {
    do {
      let mailbox: Awaited<ReturnType<typeof openImapMailbox>> | undefined;
      try {
        mailbox = await openImapMailbox(inbox);
        const r = await pollOnce({ config, inbox, store, mailbox, tools: () => toolsFor({ config, callerEmail: config.callerEmail, backend, audit, ledger }), log });
        log(r.status === "busy" ? "another poller holds the lease; skipped" : `reviewed ${r.reviewed}, set aside ${r.skipped}, retry later ${r.retry_later}`);
      } catch (err) {
        // Never echo connection details: the error may name the host or user.
        log(`poll failed: ${err instanceof Error ? err.name : "error"}. Will retry.`);
      } finally {
        await mailbox?.close();
      }
      if (values.once || stopping) break;
      await new Promise((r) => setTimeout(r, inbox.pollSeconds * 1000));
    } while (!stopping);
  } finally {
    await store.close();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
