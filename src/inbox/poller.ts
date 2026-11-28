import { createHash } from "node:crypto";
import { simpleParser, type ParsedMail } from "mailparser";
import type { CommerceTools } from "../assistant/commerce.js";
import type { Extractor, RfqDocument } from "../assistant/extract/schema.js";
import { ReviewStore } from "../assistant/reviews.js";
import { MAX_RFQ_LINES, runReview } from "../assistant/summary.js";
import type { Config, InboxConfig } from "../config.js";
import { ToolError } from "../errors.js";
import { cleanText } from "../tools/define.js";
import type { StateStore } from "../http/state.js";
import type { Mailbox } from "./mailbox.js";

/** Messages read per poll. */
export const BATCH = 20;
/** Largest message fetched, attachments included. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** Attachments read from one message. */
export const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 200_000;
/** A body shorter than this ("please see attached") is not reviewed when there are attachments. */
const MIN_BODY = 40;
const TEXT_EXT = [".txt", ".csv", ".eml"];

export interface PollerDeps {
  config: Config;
  inbox: InboxConfig;
  store: StateStore;
  mailbox: Mailbox;
  /** Store tools acting as the configured company user (config.callerEmail). */
  tools: () => Promise<CommerceTools>;
  extractor?: Extractor;
  now?: () => number;
  log?: (line: string) => void;
}

export interface PollResult {
  status: "done" | "busy";
  reviewed: number;
  skipped: number;
  retry_later: number;
}

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function senderAllowed(from: string | undefined, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const addr = (from ?? "").toLowerCase().trim();
  const at = addr.lastIndexOf("@");
  if (at < 1) return false;
  const domain = addr.slice(at + 1);
  return allowed.some((a) => (a.includes("@") ? a === addr : domain === a || domain.endsWith(`.${a}`)));
}

/** The documents to review in one email: its usable attachments, or else its body. */
export function documentsFrom(mail: ParsedMail, pdfAllowed: boolean): { docs: RfqDocument[]; skipped: string[] } {
  const subject = cleanText(mail.subject ?? "RFQ by email", 120) || "RFQ by email";
  const docs: RfqDocument[] = [];
  const skipped: string[] = [];
  for (const a of mail.attachments.slice(0, MAX_ATTACHMENTS)) {
    const name = cleanText(a.filename ?? "attachment", 80);
    const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
    if (a.size > MAX_ATTACHMENT_BYTES) {
      skipped.push(`${name}: over 20 MB`);
      continue;
    }
    if (ext === ".pdf" || a.contentType === "application/pdf") {
      if (!pdfAllowed) {
        skipped.push(`${name}: PDF needs Claude intake`);
        continue;
      }
      docs.push({ kind: "pdf", name: `${subject} / ${name}`, base64: a.content.toString("base64") });
    } else if (TEXT_EXT.includes(ext) || a.contentType === "text/csv" || a.contentType === "text/plain") {
      docs.push({ kind: "text", name: `${subject} / ${name}`, text: a.content.toString("utf8").slice(0, MAX_TEXT) });
    } else {
      skipped.push(`${name}: not a type the assistant reads`);
    }
  }
  if (mail.attachments.length > MAX_ATTACHMENTS) skipped.push(`${mail.attachments.length - MAX_ATTACHMENTS} more attachment(s) not read`);
  const body = (mail.text ?? (typeof mail.html === "string" ? cleanText(mail.html, Infinity) : "")).trim();
  if (!docs.length || body.length >= MIN_BODY * 4) {
    if (body.length >= (docs.length ? MIN_BODY : 1)) docs.unshift({ kind: "text", name: subject, text: body.slice(0, MAX_TEXT) });
  }
  return { docs, skipped };
}

const transient = (err: unknown) => err instanceof ToolError && err.retryable;

/**
 * One pass over the mailbox (ADR 25). Reviews each new RFQ as the configured company user and puts it in that
 * user's queue on the web page. It never drafts or sends anything: a person does that on the page. Logs carry
 * counts and reasons, never message text or addresses.
 */
export async function pollOnce(deps: PollerDeps): Promise<PollResult> {
  const { config, inbox, store, mailbox } = deps;
  const log = deps.log ?? ((l: string) => process.stderr.write(`[rfq-inbox] ${l}\n`));
  const owner = config.callerEmail;
  const leaseMs = Math.max(inbox.pollSeconds * 1000, 60_000) * 5;
  if ((await store.increment("inbox-lease", sha(`${inbox.host}|${inbox.user}|${inbox.folder}`), leaseMs)) !== 1) {
    return { status: "busy", reviewed: 0, skipped: 0, retry_later: 0 };
  }
  const reviews = new ReviewStore(store, config.rfq.retentionDays, deps.now);
  const result: PollResult = { status: "done", reviewed: 0, skipped: 0, retry_later: 0 };
  let tools: CommerceTools | undefined;
  try {
    for (const m of await mailbox.fetchUnread(BATCH, MAX_MESSAGE_BYTES)) {
      if (!m.raw.length) {
        log(`message ${m.uid}: over ${MAX_MESSAGE_BYTES / 1024 / 1024} MB, set aside`);
        await mailbox.setAside(m.uid);
        result.skipped++;
        continue;
      }
      let mail: ParsedMail;
      try {
        mail = await simpleParser(m.raw, { skipImageLinks: true, skipTextToHtml: true });
      } catch {
        log(`message ${m.uid}: could not be parsed, set aside`);
        await mailbox.setAside(m.uid);
        result.skipped++;
        continue;
      }
      const seenKey = sha(mail.messageId ?? m.raw);
      if (await store.get("inbox-seen", seenKey)) {
        await mailbox.markDone(m.uid);
        result.skipped++;
        continue;
      }
      if (!senderAllowed(mail.from?.value[0]?.address, inbox.allowedSenders)) {
        log(`message ${m.uid}: sender not in COMMERCE_INBOX_ALLOWED_SENDERS, set aside`);
        await mailbox.setAside(m.uid);
        result.skipped++;
        continue;
      }
      const { docs, skipped } = documentsFrom(mail, config.rfq.extractor === "claude");
      for (const why of skipped) log(`message ${m.uid}: ${why}`);
      if (!docs.length) {
        log(`message ${m.uid}: nothing to review, set aside`);
        await mailbox.setAside(m.uid);
        result.skipped++;
        continue;
      }
      try {
        tools ??= await deps.tools();
        for (const doc of docs) {
          const review = await runReview(doc, config.rfq, tools, deps.extractor);
          if (!review.lines.length) {
            log(`message ${m.uid}: no RFQ lines found in one part`);
            continue;
          }
          if (review.lines.length > MAX_RFQ_LINES) log(`message ${m.uid}: ${review.lines.length} lines; the web page reviews it but cannot draft more than one quote's worth at once`);
          await reviews.create(owner, "inbox", doc.name, review);
          result.reviewed++;
        }
      } catch (err) {
        if (transient(err)) {
          // The store or the intake model is down: leave the message unread for the next poll.
          log(`message ${m.uid}: ${(err as ToolError).message} Will retry.`);
          result.retry_later++;
          continue;
        }
        log(`message ${m.uid}: ${err instanceof ToolError ? err.message : "review failed"}; set aside`);
        await mailbox.setAside(m.uid);
        result.skipped++;
        continue;
      }
      await store.set("inbox-seen", seenKey, 1, config.rfq.retentionDays * 24 * 3600_000);
      await mailbox.markDone(m.uid);
    }
  } finally {
    await tools?.close();
    await store.delete("inbox-lease", sha(`${inbox.host}|${inbox.user}|${inbox.folder}`));
  }
  return result;
}
