import { randomBytes } from "node:crypto";
import type { StateStore } from "../http/state.js";
import type { QuoteReview } from "./pipeline.js";

/**
 * Saved RFQ reviews, one queue per company user, kept in the server's state store (encrypted in Redis, ADR 19).
 * Only the review is kept: the extraction and the line results. The original email body and attachment bytes are
 * never stored (ADR 18). Every entry expires after the retention period.
 */
export interface SavedReview {
  id: string;
  owner: string;
  source: "upload" | "inbox";
  title: string;
  created_at: string;
  updated_at: string;
  review: QuoteReview;
  /** Set once a draft quote was saved from this review. */
  drafted?: { quote_id: string; at: string };
}

export type SavedReviewSummary = Omit<SavedReview, "review"> & { lines: number; ready_lines: number; review_lines: number; suspicious: boolean };

const NS = "rfq-review";
const INDEX = "rfq-index";
const LOCK = "rfq-index-lock";
/** Most saved reviews per user; the oldest drops out of the queue beyond this. */
export const MAX_REVIEWS_PER_USER = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ReviewStore {
  constructor(
    private readonly store: StateStore,
    private readonly retentionDays: number,
    private readonly now: () => number = Date.now,
  ) {}

  private get ttlMs() {
    return this.retentionDays * 24 * 3600_000;
  }

  private key(owner: string, id: string) {
    return `${owner.toLowerCase()}|${id}`;
  }

  /** Read-modify-write the owner's index under a short lease, so the inbox and the web page cannot drop each other's entries. */
  private async withIndex(owner: string, fn: (ids: string[]) => string[] | Promise<string[]>): Promise<void> {
    const who = owner.toLowerCase();
    for (let i = 0; ; i++) {
      if ((await this.store.increment(LOCK, who, 5_000)) === 1) break;
      if (i >= 100) throw new Error("The review queue is busy. Try again.");
      await sleep(20);
    }
    try {
      const ids = (await this.store.get<string[]>(INDEX, who)) ?? [];
      await this.store.set(INDEX, who, (await fn(ids)).slice(-MAX_REVIEWS_PER_USER), this.ttlMs);
    } finally {
      await this.store.delete(LOCK, who);
    }
  }

  async create(owner: string, source: SavedReview["source"], title: string, review: QuoteReview): Promise<SavedReview> {
    const at = new Date(this.now()).toISOString();
    const saved: SavedReview = { id: randomBytes(12).toString("base64url"), owner: owner.toLowerCase(), source, title: title.slice(0, 200), created_at: at, updated_at: at, review };
    await this.store.set(NS, this.key(owner, saved.id), saved, this.ttlMs);
    await this.withIndex(owner, (ids) => [...ids, saved.id]);
    return saved;
  }

  /** Only the owner's own reviews exist for them: the key includes the owner. */
  async get(owner: string, id: string): Promise<SavedReview | undefined> {
    if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return undefined;
    const r = await this.store.get<SavedReview>(NS, this.key(owner, id));
    return r && r.owner === owner.toLowerCase() ? r : undefined;
  }

  /** Save a changed review. The retention clock starts again from the change. */
  async update(saved: SavedReview): Promise<SavedReview> {
    const next = { ...saved, updated_at: new Date(this.now()).toISOString() };
    await this.store.set(NS, this.key(saved.owner, saved.id), next, this.ttlMs);
    return next;
  }

  async list(owner: string): Promise<SavedReviewSummary[]> {
    const ids = (await this.store.get<string[]>(INDEX, owner.toLowerCase())) ?? [];
    const out: SavedReviewSummary[] = [];
    for (const id of [...ids].reverse()) {
      const r = await this.get(owner, id);
      if (!r) continue;
      const { review, ...meta } = r;
      out.push({
        ...meta,
        lines: review.lines.length,
        ready_lines: review.totals.ready_lines,
        review_lines: review.totals.review_lines,
        suspicious: review.extraction.suspicious_instructions.length > 0,
      });
    }
    if (out.length !== ids.length) await this.withIndex(owner, (cur) => cur.filter((id) => out.some((o) => o.id === id)));
    return out;
  }

  async delete(owner: string, id: string): Promise<void> {
    await this.store.delete(NS, this.key(owner, id));
    await this.withIndex(owner, (ids) => ids.filter((x) => x !== id));
  }

  /** Delete the owner's reviews created more than `days` days ago (or all of them with 0). Returns how many. */
  async forget(owner: string, days: number): Promise<number> {
    const cutoff = this.now() - days * 24 * 3600_000;
    let n = 0;
    for (const r of await this.list(owner)) {
      if (Date.parse(r.created_at) <= cutoff) {
        await this.delete(owner, r.id);
        n++;
      }
    }
    return n;
  }
}
