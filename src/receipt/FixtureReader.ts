import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ReadReceiptSchema, checkTotals, type ReceiptReader, type ReceiptReadResult } from "./types.js";

export class FixtureReader implements ReceiptReader {
  constructor(private dir = "fixtures/receipts") {}
  list(): string[] {
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  }
  async read({ fixtureId }: { fixtureId?: string }): Promise<ReceiptReadResult> {
    if (!fixtureId || !/^[\w-]+$/.test(fixtureId)) throw new Error(`Invalid fixture id: ${fixtureId}`);
    const raw = JSON.parse(readFileSync(join(this.dir, `${fixtureId}.json`), "utf8"));
    return checkTotals(ReadReceiptSchema.parse(raw), "fixture");
  }
}
