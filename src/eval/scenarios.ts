import type { Receipt, Assignment } from "../core/split.js";

export type Scenario = {
  id: string;
  title: string;
  receipt: Receipt;
  assignment: Assignment;
  /** Who paid the bill (the creditor). */
  payer: string;
  /** Simulated: how many times the create step is retried (a retry must never duplicate). */
  createRetries: number;
  /** Simulated: try to execute money moves before approval. */
  tryWithoutApproval: boolean;
  /** People who pay right away (no reminder for them). */
  paysImmediately: string[];
  /** Days to advance the clock before the reminder run, and the reminder threshold. */
  reminderAfterDays: number;
  clockDays: number;
};

// Deterministic generator: same 20 scenarios every run.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
const NAMES = ["Ana", "Ben", "Cai", "Dani", "Eli", "Fer", "Gus", "Hana"];

export function buildScenarios(): Scenario[] {
  const r = rng(2026);
  const out: Scenario[] = [];
  for (let k = 0; k < 20; k++) {
    const n = 2 + (k % 7); // 2..8 people
    const people = NAMES.slice(0, n);
    const itemCount = 2 + Math.floor(r() * 8);
    const items = Array.from({ length: itemCount }, (_, i) => ({ id: `i${i}`, name: `item ${i}`, totalCents: 100 + Math.floor(r() * 3000) }));
    const assignment: Assignment = {};
    items.forEach((it, i) => {
      const shared = r() < 0.35;
      assignment[it.id] = shared ? people.filter(() => r() < 0.6).concat(people[i % n]).filter((p, j, a) => a.indexOf(p) === j) : [people[i % n]];
    });
    const sum = items.reduce((a, i) => a + i.totalCents, 0);
    const taxCents = k % 3 === 0 ? Math.round(sum * 0.08) : 0;
    const tipCents = k % 4 === 0 ? Math.round(sum * 0.12) : 0;
    out.push({
      id: `S${String(k + 1).padStart(2, "0")}`,
      title: `${n} people, ${itemCount} items${taxCents ? ", tax" : ""}${tipCents ? ", tip" : ""}`,
      receipt: { currency: "EUR", items, taxCents, tipCents, totalCents: sum + taxCents + tipCents },
      assignment,
      payer: people[Math.floor(r() * n)],
      createRetries: k % 5 === 0 ? 2 : 0,
      tryWithoutApproval: k % 2 === 0,
      paysImmediately: people.filter(() => r() < 0.4),
      reminderAfterDays: 3,
      clockDays: [0, 3, 7][k % 3],
    });
  }
  return out;
}
