import { allocate, assertCents, type Cents } from "./money.js";

export type ReceiptItem = { id: string; name: string; totalCents: Cents };
export type Receipt = {
  currency: string;
  items: ReceiptItem[];
  taxCents: Cents;
  tipCents: Cents;
  totalCents: Cents;
};
/** itemId → people who share it (split evenly). */
export type Assignment = Record<string, string[]>;

export type SplitResult = {
  /** person → cents owed for the whole receipt (items + tax + tip). Sums exactly to totalCents. */
  owed: Record<string, Cents>;
  subtotals: Record<string, Cents>;
  people: string[];
};

export class SplitError extends Error {}

export function receiptMismatch(r: Receipt): Cents {
  const items = r.items.reduce((a, i) => a + i.totalCents, 0);
  return r.totalCents - (items + r.taxCents + r.tipCents);
}

/**
 * Items go to the people who had them (shared items split evenly, largest remainder).
 * Tax and tip are spread in proportion to each person's item subtotal.
 */
export function splitReceipt(receipt: Receipt, assignment: Assignment): SplitResult {
  for (const i of receipt.items) assertCents(i.totalCents, `item ${i.id}`);
  assertCents(receipt.taxCents, "tax");
  assertCents(receipt.tipCents, "tip");
  const mismatch = receiptMismatch(receipt);
  if (mismatch !== 0) throw new SplitError(`Receipt does not add up: off by ${mismatch} cents`);

  const people: string[] = [];
  const subtotals: Record<string, Cents> = {};
  for (const item of receipt.items) {
    const who = assignment[item.id];
    if (!who || who.length === 0) throw new SplitError(`Item "${item.name}" is not assigned to anyone`);
    if (new Set(who).size !== who.length) throw new SplitError(`Item "${item.name}" lists a person twice`);
    const shares = allocate(item.totalCents, who.map(() => 1));
    who.forEach((p, k) => {
      if (!(p in subtotals)) {
        people.push(p);
        subtotals[p] = 0;
      }
      subtotals[p] += shares[k];
    });
  }
  if (people.length === 0) throw new SplitError("Receipt has no items");

  const weights = people.map((p) => Math.max(subtotals[p], 0));
  const extra = allocate(receipt.taxCents + receipt.tipCents, weights);
  const owed: Record<string, Cents> = {};
  people.forEach((p, k) => (owed[p] = subtotals[p] + extra[k]));
  return { owed, subtotals, people };
}
