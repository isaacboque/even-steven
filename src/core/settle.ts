import { assertCents, type Cents } from "./money.js";

/** One payment: `amount` cents paid by `payer`, owed by people in proportion to `shares` (cents, must sum to amount). */
export type Expense = { payer: string; amountCents: Cents; owedCents: Record<string, Cents> };
export type Transfer = { from: string; to: string; amountCents: Cents };
export type Settlement = {
  balances: Record<string, Cents>;
  transfers: Transfer[];
  method: "greedy" | "exact";
  /** True when the exact solver found fewer transfers than greedy. */
  greedyWasSuboptimal: boolean;
};

/** Net balance per person: paid minus owed. Positive = is owed money. Always sums to zero. */
export function netBalances(expenses: Expense[]): Record<string, Cents> {
  const b: Record<string, Cents> = {};
  for (const e of expenses) {
    assertCents(e.amountCents, "expense");
    const owedSum = Object.values(e.owedCents).reduce((a, c) => a + assertCents(c, "share"), 0);
    if (owedSum !== e.amountCents) throw new Error(`Shares (${owedSum}) do not add up to the expense (${e.amountCents})`);
    b[e.payer] = (b[e.payer] ?? 0) + e.amountCents;
    for (const [p, c] of Object.entries(e.owedCents)) b[p] = (b[p] ?? 0) - c;
  }
  return b;
}

/** Largest creditor ↔ largest debtor until everyone is square. At most n-1 transfers. */
export function greedyTransfers(balances: Record<string, Cents>): Transfer[] {
  const cred = Object.entries(balances).filter(([, v]) => v > 0).map(([p, v]) => ({ p, v }));
  const debt = Object.entries(balances).filter(([, v]) => v < 0).map(([p, v]) => ({ p, v: -v }));
  const out: Transfer[] = [];
  const byDesc = (a: { p: string; v: number }, b: { p: string; v: number }) => b.v - a.v || a.p.localeCompare(b.p);
  while (cred.length && debt.length) {
    cred.sort(byDesc);
    debt.sort(byDesc);
    const c = cred[0];
    const d = debt[0];
    const amt = Math.min(c.v, d.v);
    out.push({ from: d.p, to: c.p, amountCents: amt });
    c.v -= amt;
    d.v -= amt;
    if (c.v === 0) cred.shift();
    if (d.v === 0) debt.shift();
  }
  return out;
}

/**
 * Exact minimum: n_nonzero - (max number of disjoint zero-sum groups). Bitmask DP, fine up to ~16 people.
 */
export function exactTransfers(balances: Record<string, Cents>): Transfer[] {
  const people = Object.entries(balances).filter(([, v]) => v !== 0);
  const n = people.length;
  if (n === 0) return [];
  if (n > 16) throw new Error("exactTransfers supports at most 16 people with a non-zero balance");
  const full = (1 << n) - 1;
  const sum = new Array<number>(1 << n).fill(0);
  for (let m = 1; m <= full; m++) {
    const low = m & -m;
    sum[m] = sum[m ^ low] + people[31 - Math.clz32(low)][1];
  }
  // dp[m] = max number of zero-sum groups that partition m (only defined when sum[m] === 0)
  const dp = new Array<number>(1 << n).fill(-1);
  const choice = new Array<number>(1 << n).fill(0);
  dp[0] = 0;
  for (let m = 1; m <= full; m++) {
    if (sum[m] !== 0) continue;
    const low = m & -m; // the group containing the lowest member
    for (let s = m; s; s = (s - 1) & m) {
      if (!(s & low) || sum[s] !== 0) continue;
      const rest = dp[m ^ s];
      if (rest >= 0 && rest + 1 > dp[m]) {
        dp[m] = rest + 1;
        choice[m] = s;
      }
    }
  }
  const out: Transfer[] = [];
  for (let m = full; m; m ^= choice[m]) {
    const group: Record<string, Cents> = {};
    for (let i = 0; i < n; i++) if (choice[m] & (1 << i)) group[people[i][0]] = people[i][1];
    out.push(...greedyTransfers(group));
  }
  return out;
}

const EXACT_LIMIT = 8;

/** Fewest transfers: greedy always, exact solver for groups up to 8 people; returns the shorter one. */
export function minTransfers(balances: Record<string, Cents>): Settlement {
  const total = Object.values(balances).reduce((a, b) => a + assertCents(b, "balance"), 0);
  if (total !== 0) throw new Error(`Balances must sum to zero, got ${total}`);
  const greedy = greedyTransfers(balances);
  const nonZero = Object.values(balances).filter((v) => v !== 0).length;
  if (nonZero > EXACT_LIMIT) return { balances, transfers: greedy, method: "greedy", greedyWasSuboptimal: false };
  const exact = exactTransfers(balances);
  if (exact.length < greedy.length) return { balances, transfers: exact, method: "exact", greedyWasSuboptimal: true };
  return { balances, transfers: greedy, method: "greedy", greedyWasSuboptimal: false };
}

/** Apply transfers to balances; result should be all zeros. */
export function applyTransfers(balances: Record<string, Cents>, transfers: Transfer[]): Record<string, Cents> {
  const b = { ...balances };
  for (const t of transfers) {
    b[t.from] = (b[t.from] ?? 0) + t.amountCents;
    b[t.to] = (b[t.to] ?? 0) - t.amountCents;
  }
  return b;
}
