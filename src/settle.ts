// Net balance per person: paid minus owed. Balances always sum to zero.
export type Expense = { payer: string; amount: number; shares: Record<string, number> };

export function netBalances(expenses: Expense[]): Record<string, number> {
  const balances: Record<string, number> = {};
  for (const e of expenses) {
    balances[e.payer] = (balances[e.payer] ?? 0) + e.amount;
    const total = Object.values(e.shares).reduce((a, b) => a + b, 0);
    for (const [person, share] of Object.entries(e.shares)) {
      balances[person] = (balances[person] ?? 0) - (e.amount * share) / total;
    }
  }
  return balances;
}
