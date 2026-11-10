import { z } from "zod";

export const ReceiptLineSchema = z.object({
  name: z.string().describe("Item name as printed"),
  qty: z.number().int().positive().describe("Quantity, 1 if not printed"),
  unitCents: z.number().int().describe("Unit price in cents"),
  totalCents: z.number().int().describe("Line total in cents (qty x unit, after line discounts)"),
});

export const ReadReceiptSchema = z.object({
  merchant: z.string().describe("Shop or restaurant name, empty if unreadable"),
  currency: z.string().length(3).describe("ISO 4217 code, e.g. EUR"),
  items: z.array(ReceiptLineSchema),
  taxCents: z.number().int().describe("Tax added on top of item prices; 0 if prices already include tax"),
  tipCents: z.number().int().describe("Tip or service charge; 0 if none"),
  totalCents: z.number().int().describe("Grand total printed on the receipt"),
});

export type ReadReceipt = z.infer<typeof ReadReceiptSchema>;
export type ReceiptReadResult = ReadReceipt & {
  /** totalCents - (items + tax + tip). 0 means it adds up; otherwise the user must fix it. */
  mismatchCents: number;
  source: "fixture" | "vision";
};

export interface ReceiptReader {
  read(input: { image?: Uint8Array; mediaType?: string; fixtureId?: string }): Promise<ReceiptReadResult>;
}

export function checkTotals(r: ReadReceipt, source: ReceiptReadResult["source"]): ReceiptReadResult {
  const sum = r.items.reduce((a, i) => a + i.totalCents, 0) + r.taxCents + r.tipCents;
  return { ...r, mismatchCents: r.totalCents - sum, source };
}
