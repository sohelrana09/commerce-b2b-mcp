import type { Cost, Scores } from "./run.js";

/**
 * Service targets for the quote assistant (docs/service-targets.md).
 * Only `gate` targets fail the eval; the rest are reported so a regression is visible.
 */
export interface Target {
  name: string;
  threshold: string;
  gate: boolean;
  /** Undefined when the run has no data for it (e.g. cost for the rule-based intake). */
  check(s: Scores, c: Cost | undefined): { value: string; ok: boolean } | undefined;
}

const pct = (n: number, d: number) => (d ? (100 * n) / d : 0);

export const TARGETS: Target[] = [
  {
    name: "Wrong lines marked ready",
    threshold: "0",
    gate: true,
    check: (s) => ({ value: String(s.unsafe_ready), ok: s.unsafe_ready === 0 }),
  },
  {
    name: "Lines found",
    threshold: ">= 98%",
    gate: false,
    check: (s) => {
      const v = pct(s.lines_found, s.expected_lines);
      return { value: `${v.toFixed(1)}%`, ok: v >= 98 };
    },
  },
  {
    name: "Needs-review caught",
    threshold: ">= 95%",
    gate: false,
    check: (s) => {
      const v = pct(s.review_caught, s.expected_review);
      return { value: `${v.toFixed(1)}%`, ok: v >= 95 };
    },
  },
  {
    name: "Review flags that were needed",
    threshold: ">= 70%",
    gate: false,
    check: (s) => {
      const v = pct(s.review_caught, s.flagged_review);
      return { value: `${v.toFixed(1)}%`, ok: v >= 70 };
    },
  },
  {
    name: "Accepted without edits",
    threshold: ">= 70%",
    gate: false,
    check: (s) => {
      const v = pct(s.accepted_without_edits, s.expected_lines);
      return { value: `${v.toFixed(1)}%`, ok: v >= 70 };
    },
  },
  {
    name: "Intake cost per RFQ (list price)",
    threshold: "<= $0.15",
    gate: false,
    check: (_s, c) => {
      if (!c || c.usd === undefined) return undefined;
      const v = c.usd / c.rfqs;
      return { value: `$${v.toFixed(4)}`, ok: v <= 0.15 };
    },
  },
  {
    name: "Intake time per line (average)",
    threshold: "<= 3.0 s",
    gate: false,
    check: (s, c) => {
      if (!c) return undefined;
      const v = c.ms / 1000 / Math.max(1, s.predicted_lines);
      return { value: `${v.toFixed(2)} s`, ok: v <= 3 };
    },
  },
  {
    name: "Slowest RFQ in the set (up to 20 lines)",
    threshold: "<= 90 s",
    gate: false,
    check: (_s, c) => {
      if (!c) return undefined;
      const v = c.max_ms / 1000;
      return { value: `${v.toFixed(1)} s`, ok: v <= 90 };
    },
  },
];

export function targetTable(s: Scores, c: Cost | undefined): string {
  const rows = TARGETS.flatMap((t) => {
    const r = t.check(s, c);
    if (!r) return [];
    return [`| ${t.name}${t.gate ? " (release gate)" : ""} | ${t.threshold} | ${r.value} | ${r.ok ? "met" : "**missed**"} |`];
  });
  return ["### Service targets", "", "| Target | Threshold | This run | Status |", "|---|---|---|---|", ...rows].join("\n");
}
