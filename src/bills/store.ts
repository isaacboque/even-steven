import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Receipt, Assignment } from "../core/split.js";

export type Person = { name: string; email?: string };
export type Bill = {
  id: string;
  createdAt: string;
  merchant: string;
  receipt: Receipt;
  /** Shown to the user before continuing; must be 0 to split. */
  mismatchCents: number;
  people: Person[];
  payer?: string;
  assignment: Assignment;
};

export class BillStore {
  private bills = new Map<string, Bill>();
  private seq = 0;
  constructor(private file?: string) {
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { seq: number; bills: Bill[] };
      this.seq = saved.seq;
      saved.bills.forEach((b) => this.bills.set(b.id, b));
    }
  }
  create(b: Omit<Bill, "id" | "createdAt">): Bill {
    const bill = { ...b, id: `bill-${++this.seq}`, createdAt: new Date().toISOString() };
    this.bills.set(bill.id, bill);
    this.save();
    return bill;
  }
  get(id: string): Bill {
    const b = this.bills.get(id);
    if (!b) throw new NotFound(`Unknown bill ${id}`);
    return b;
  }
  update(id: string, patch: Partial<Bill>): Bill {
    const b = { ...this.get(id), ...patch, id };
    this.bills.set(id, b);
    this.save();
    return b;
  }
  list(): Bill[] {
    return [...this.bills.values()];
  }
  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ seq: this.seq, bills: this.list() }, null, 2));
  }
}
export class NotFound extends Error {}
