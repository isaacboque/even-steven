import { splitReceipt } from "../core/split.js";
import { minTransfers, type Settlement } from "../core/settle.js";
import type { Bill } from "../bills/store.js";

export type BillSettlement = Settlement & { owed: Record<string, number>; subtotals: Record<string, number>; payer: string };

/** The payer paid the whole receipt; everyone else owes their share to them (fewest transfers). */
export function settleBill(bill: Bill): BillSettlement {
  if (!bill.payer) throw new Error("Choose who paid the bill first");
  const split = splitReceipt(bill.receipt, bill.assignment);
  const balances: Record<string, number> = {};
  for (const [p, c] of Object.entries(split.owed)) balances[p] = -c;
  balances[bill.payer] = (balances[bill.payer] ?? 0) + bill.receipt.totalCents;
  return { ...minTransfers(balances), owed: split.owed, subtotals: split.subtotals, payer: bill.payer };
}
