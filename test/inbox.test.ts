import { describe, expect, it } from "vitest";
import { inProcessTools } from "../src/assistant/in-process.js";
import type { Extractor } from "../src/assistant/extract/schema.js";
import { ReviewStore } from "../src/assistant/reviews.js";
import { loadConfig, loadInbox, type InboxConfig } from "../src/config.js";
import { ToolError } from "../src/errors.js";
import { MemoryStore } from "../src/http/state.js";
import type { InboxMessage, Mailbox } from "../src/inbox/mailbox.js";
import { pollOnce, senderAllowed } from "../src/inbox/poller.js";

const SAM = "sam.purchasing@harbour.example";
const config = loadConfig({ COMMERCE_BACKEND: "mock", COMMERCE_CALLER_EMAIL: SAM, COMMERCE_CONFIRM_SECRET: "test-secret" });
const inbox: InboxConfig = { host: "imap.example.test", port: 993, user: "rfq@supplier.example", password: "x", folder: "INBOX", pollSeconds: 60, allowedSenders: ["harbour.example"] };

const email = (opts: { from?: string; id?: string; subject?: string; body?: string; csv?: string; exe?: boolean }) => {
  const b = "BOUNDARY42";
  const parts = [
    `From: ${opts.from ?? "Buyer <purchasing@harbour.example>"}`,
    "To: rfq@supplier.example",
    `Subject: ${opts.subject ?? "RFQ HM-1"}`,
    `Message-ID: <${opts.id ?? "m1"}@harbour.example>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body ?? "Please quote:\n1. M8 x 30 A4 hex setscrew - 100 off\n2. M10 x 50 A2 hex bolt - 200 off\n",
  ];
  if (opts.csv) parts.push(`--${b}`, 'Content-Type: text/csv; name="rfq.csv"', 'Content-Disposition: attachment; filename="rfq.csv"', "Content-Transfer-Encoding: base64", "", Buffer.from(opts.csv).toString("base64"));
  if (opts.exe) parts.push(`--${b}`, 'Content-Type: application/octet-stream; name="run.exe"', 'Content-Disposition: attachment; filename="run.exe"', "Content-Transfer-Encoding: base64", "", Buffer.from("MZ").toString("base64"));
  parts.push(`--${b}--`, "");
  return Buffer.from(parts.join("\r\n"));
};

function fakeMailbox(raws: Buffer[]) {
  const messages: Array<InboxMessage & { state: "unread" | "done" | "aside" }> = raws.map((raw, i) => ({ uid: i + 1, raw, state: "unread" }));
  const mb: Mailbox = {
    async fetchUnread(limit) {
      return messages.filter((m) => m.state === "unread").slice(0, limit).map(({ uid, raw }) => ({ uid, raw }));
    },
    async markDone(uid) {
      messages.find((m) => m.uid === uid)!.state = "done";
    },
    async setAside(uid) {
      messages.find((m) => m.uid === uid)!.state = "aside";
    },
    async close() {},
  };
  return { mb, messages };
}

async function run(raws: Buffer[], opts: { extractor?: Extractor; store?: MemoryStore } = {}) {
  const store = opts.store ?? new MemoryStore();
  const { mb, messages } = fakeMailbox(raws);
  const calls: string[] = [];
  const result = await pollOnce({
    config,
    inbox,
    store,
    mailbox: mb,
    tools: async () => {
      const t = await inProcessTools(SAM);
      return { call: (name, args) => (calls.push(name), t.call(name, args)), close: t.close };
    },
    ...(opts.extractor ? { extractor: opts.extractor } : {}),
    log: () => undefined,
  });
  return { result, messages, store, calls, queue: await new ReviewStore(store, 14).list(SAM) };
}

describe("inbox poller", () => {
  it("reviews an RFQ email into the company user's queue, marks it done, and never drafts", async () => {
    const { result, messages, queue, calls } = await run([email({})]);
    expect(result).toMatchObject({ status: "done", reviewed: 1 });
    expect(messages[0]!.state).toBe("done");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ source: "inbox", title: "RFQ HM-1", lines: 2 });
    expect(calls).not.toContain("draft_negotiable_quote");
  });

  it("reviews a CSV attachment, and skips attachment types it cannot read", async () => {
    const csv = "line,description,qty\n1,M8 x 30 A4 hex setscrew,100\n2,M6 A4 hex nut,200\n";
    const { queue } = await run([email({ body: "See attached.", csv, exe: true })]);
    expect(queue.map((q) => q.title)).toEqual(["RFQ HM-1 / rfq.csv"]);
  });

  it("reviews each message once, even if it arrives twice", async () => {
    const store = new MemoryStore();
    await run([email({ id: "same" })], { store });
    const second = await run([email({ id: "same" })], { store });
    expect(second.result.reviewed).toBe(0);
    expect(second.queue).toHaveLength(1);
    expect(second.messages[0]!.state).toBe("done");
  });

  it("sets aside mail from senders who are not allowed", async () => {
    const { result, messages, queue } = await run([email({ from: "Someone <x@elsewhere.example>" })]);
    expect(result.skipped).toBe(1);
    expect(messages[0]!.state).toBe("aside");
    expect(queue).toEqual([]);
  });

  it("leaves a message unread when the store or the model is down, for the next poll", async () => {
    const down: Extractor = { name: "down", extract: async () => Promise.reject(new ToolError("UPSTREAM_UNAVAILABLE", "The RFQ intake model is unavailable right now.")) };
    const { result, messages } = await run([email({})], { extractor: down });
    expect(result.retry_later).toBe(1);
    expect(messages[0]!.state).toBe("unread");
  });

  it("does not run while another poller holds the lease", async () => {
    const store = new MemoryStore();
    await store.increment("inbox-lease", "x", 60_000); // a different mailbox's lease does not block
    const hold = new MemoryStore();
    const { createHash } = await import("node:crypto");
    await hold.increment("inbox-lease", createHash("sha256").update(`${inbox.host}|${inbox.user}|${inbox.folder}`).digest("hex"), 60_000);
    expect((await run([email({})], { store })).result.status).toBe("done");
    const blocked = await run([email({})], { store: hold });
    expect(blocked.result.status).toBe("busy");
    expect(blocked.messages[0]!.state).toBe("unread");
  });
});

describe("inbox settings", () => {
  it("matches allowed addresses and domains, including subdomains", () => {
    expect(senderAllowed("a@harbour.example", ["harbour.example"])).toBe(true);
    expect(senderAllowed("a@mail.harbour.example", ["harbour.example"])).toBe(true);
    expect(senderAllowed("a@evilharbour.example", ["harbour.example"])).toBe(false);
    expect(senderAllowed("a@x.example", ["b@x.example"])).toBe(false);
    expect(senderAllowed(undefined, ["x.example"])).toBe(false);
    expect(senderAllowed("anyone@anywhere.example", [])).toBe(true);
  });

  it("requires credentials and validates the allowlist", () => {
    expect(() => loadInbox({ COMMERCE_INBOX_HOST: "imap.example.com" })).toThrow(/PASSWORD/);
    expect(() => loadInbox({ COMMERCE_INBOX_HOST: "imap.example.com", COMMERCE_INBOX_USER: "u", COMMERCE_INBOX_PASSWORD: "p", COMMERCE_INBOX_ALLOWED_SENDERS: "not a domain" })).toThrow(/not an address or domain/);
    expect(loadInbox({ COMMERCE_INBOX_HOST: "imap.example.com", COMMERCE_INBOX_USER: "u", COMMERCE_INBOX_PASSWORD: "p", COMMERCE_INBOX_ALLOWED_SENDERS: "@Harbour.example, buyer@x.example" }).allowedSenders).toEqual(["harbour.example", "buyer@x.example"]);
  });
});
