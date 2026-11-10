// Money is always an integer number of cents.
export type Cents = number;

export function assertCents(value: number, label = "amount"): Cents {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer number of cents, got ${value}`);
  return value;
}

/** "12.34" | "12,34" | "12" | 12.34 → 1234. Rejects more than 2 decimals. */
export function parseCents(input: string | number): Cents {
  const raw = typeof input === "number" ? input.toString() : input.trim().replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) throw new Error(`Not a money amount: "${input}"`);
  const negative = raw.startsWith("-");
  const [whole, frac = ""] = raw.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return negative ? -cents : cents;
}

export function formatCents(cents: Cents, currency = "EUR"): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}

/**
 * Split `total` cents in proportion to `weights` with the largest-remainder method.
 * The parts always sum exactly to `total`. Ties go to the lower index, so the result is deterministic.
 */
export function allocate(total: Cents, weights: number[]): Cents[] {
  assertCents(total, "total");
  if (weights.length === 0) {
    if (total !== 0) throw new Error("Cannot allocate a non-zero total to nobody");
    return [];
  }
  if (weights.some((w) => w < 0 || !Number.isFinite(w))) throw new Error("Weights must be finite and >= 0");
  const sum = weights.reduce((a, b) => a + b, 0);
  const effective = sum === 0 ? weights.map(() => 1) : weights;
  const effectiveSum = sum === 0 ? weights.length : sum;

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const exact = effective.map((w) => (abs * w) / effectiveSum);
  const parts = exact.map(Math.floor);
  let left = abs - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, rem: x - Math.floor(x) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k].i] += 1;
  return parts.map((p) => p * sign);
}
