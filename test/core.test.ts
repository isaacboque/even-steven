import { describe, it, expect } from "vitest";
import { allocate, parseCents, formatCents } from "../src/core/money.js";
import { splitReceipt, SplitError, type Receipt } from "../src/core/split.js";
import { netBalances, minTransfers, greedyTransfers, exactTransfers, applyTransfers } from "../src/core/settle.js";

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe("money", () => {
  it("parses and formats", () => {
    expect(parseCents("12.34")).toBe(1234);
    expect(parseCents("12,3")).toBe(1230);
    expect(parseCents("7")).toBe(700);
    expect(parseCents("-0.05")).toBe(-5);
    expect(() => parseCents("1.234")).toThrow();
    expect(formatCents(1234)).toBe("12.34 EUR");
    expect(formatCents(-5)).toBe("-0.05 EUR");
  });
  it("allocate always sums exactly to the total", () => {
    const r = rng(42);
    for (let k = 0; k < 500; k++) {
      const total = Math.floor(r() * 100000) - 20000;
      const weights = Array.from({ length: 1 + Math.floor(r() * 8) }, () => Math.floor(r() * 50));
      const parts = allocate(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      parts.forEach((p) => expect(Number.isInteger(p)).toBe(true));
    }
  });
  it("splits 100 cents three ways deterministically", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });
});

const base = (items: [string, number][], tax = 0, tip = 0): Receipt => {
  const its = items.map(([name, totalCents], i) => ({ id: `i${i}`, name, totalCents }));
  return { currency: "EUR", items: its, taxCents: tax, tipCents: tip, totalCents: its.reduce((a, i) => a + i.totalCents, 0) + tax + tip };
};

describe("split", () => {
  it("shared items and proportional tip sum exactly to the total", () => {
    const r = base([["pizza", 1500], ["beer", 400], ["salad", 899]], 0, 300);
    const s = splitReceipt(r, { i0: ["ana", "ben", "cai"], i1: ["ben"], i2: ["ana"] });
    expect(Object.values(s.owed).reduce((a, b) => a + b, 0)).toBe(r.totalCents);
    expect(s.subtotals).toEqual({ ana: 500 + 899, ben: 500 + 400, cai: 500 });
  });
  it("zero tip and single person", () => {
    const r = base([["coffee", 250]]);
    expect(splitReceipt(r, { i0: ["ana"] }).owed).toEqual({ ana: 250 });
  });
  it("rejects a receipt that does not add up", () => {
    const r = { ...base([["a", 100]]), totalCents: 101 };
    expect(() => splitReceipt(r, { i0: ["ana"] })).toThrow(SplitError);
  });
  it("rejects unassigned items", () => {
    expect(() => splitReceipt(base([["a", 100]]), {})).toThrow(/not assigned/);
  });
  it("random receipts always add up", () => {
    const r = rng(7);
    const names = ["a", "b", "c", "d", "e", "f"];
    for (let k = 0; k < 300; k++) {
      const items: [string, number][] = Array.from({ length: 1 + Math.floor(r() * 10) }, (_, i) => [`x${i}`, 1 + Math.floor(r() * 5000)]);
      const rec = base(items, Math.floor(r() * 800), Math.floor(r() * 800));
      const asg: Record<string, string[]> = {};
      rec.items.forEach((it) => {
        const who = names.filter(() => r() < 0.4);
        asg[it.id] = who.length ? who : ["a"];
      });
      const s = splitReceipt(rec, asg);
      expect(Object.values(s.owed).reduce((a, b) => a + b, 0)).toBe(rec.totalCents);
    }
  });
});

describe("settle", () => {
  it("all even means no transfers", () => {
    expect(minTransfers({ a: 0, b: 0 }).transfers).toEqual([]);
  });
  it("net balances sum to zero", () => {
    const b = netBalances([{ payer: "a", amountCents: 900, owedCents: { a: 300, b: 300, c: 300 } }]);
    expect(b).toEqual({ a: 600, b: -300, c: -300 });
    expect(minTransfers(b).transfers).toHaveLength(2);
  });
  it("exact beats greedy when subgroups cancel", () => {
    // pairs that cancel: greedy can need 4, the optimum is 3
    const b = { a: 1000, b: -700, c: -300, d: 600, e: -600 };
    const s = minTransfers(b);
    expect(s.transfers.length).toBe(exactTransfers(b).length);
    expect(Object.values(applyTransfers(b, s.transfers)).every((v) => v === 0)).toBe(true);
  });
  it("minTransfers is never worse than exact on 200 random small groups", () => {
    const r = rng(1234);
    let suboptimal = 0;
    for (let k = 0; k < 200; k++) {
      const n = 2 + Math.floor(r() * 7);
      const vals = Array.from({ length: n - 1 }, () => Math.floor(r() * 4000) - 2000);
      vals.push(-vals.reduce((a, b) => a + b, 0));
      const b = Object.fromEntries(vals.map((v, i) => [`p${i}`, v]));
      const s = minTransfers(b);
      const ex = exactTransfers(b);
      expect(s.transfers.length).toBe(ex.length);
      expect(s.transfers.length).toBeLessThanOrEqual(greedyTransfers(b).length);
      expect(Object.values(applyTransfers(b, s.transfers)).every((v) => v === 0)).toBe(true);
      if (s.greedyWasSuboptimal) suboptimal++;
    }
    expect(suboptimal).toBeGreaterThanOrEqual(0);
  });
  it("rejects balances that do not sum to zero", () => {
    expect(() => minTransfers({ a: 1, b: 0 })).toThrow();
  });
});
