import { ImapFlow } from "imapflow";
import type { InboxConfig } from "../config.js";

/** One unread message, as its raw RFC 822 source. */
export interface InboxMessage {
  uid: number;
  raw: Buffer;
}

/** The mailbox as the poller needs it. The IMAP implementation is below; tests use a fake. */
export interface Mailbox {
  /** Unread messages, oldest first, at most `limit`. Messages over `maxBytes` are returned as `{ uid, raw: empty }` so they can be set aside. */
  fetchUnread(limit: number, maxBytes: number): Promise<InboxMessage[]>;
  /** Done with the message: move it to the done folder, or mark it read. */
  markDone(uid: number): Promise<void>;
  /** Not for us (sender not allowed, too large, nothing to read): mark it read and leave it where it is. */
  setAside(uid: number): Promise<void>;
  close(): Promise<void>;
}

export async function openImapMailbox(cfg: InboxConfig): Promise<Mailbox> {
  // TLS only: the mailbox password and the RFQs cross this connection.
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.password }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock(cfg.folder);
  return {
    async fetchUnread(limit, maxBytes) {
      const uids = ((await client.search({ seen: false }, { uid: true })) || []).sort((a, b) => a - b).slice(0, limit);
      const out: InboxMessage[] = [];
      for (const uid of uids) {
        const head = await client.fetchOne(String(uid), { size: true }, { uid: true });
        if (!head) continue;
        if ((head.size ?? 0) > maxBytes) {
          out.push({ uid, raw: Buffer.alloc(0) });
          continue;
        }
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (msg && msg.source) out.push({ uid, raw: msg.source });
      }
      return out;
    },
    async markDone(uid) {
      if (cfg.doneFolder) await client.messageMove(String(uid), cfg.doneFolder, { uid: true });
      else await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    },
    async setAside(uid) {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    },
    async close() {
      lock.release();
      await client.logout().catch(() => undefined);
    },
  };
}
