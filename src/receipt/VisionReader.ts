import { generateText, Output, type LanguageModel } from "ai";
import { ReadReceiptSchema, checkTotals, type ReceiptReader, type ReceiptReadResult } from "./types.js";
import type { Tracer } from "../trace/trace.js";

const PROMPT = `Read this receipt. Return every purchased line item with quantity, unit price and line total in integer cents.
Do not invent items. Tax: only if it is added on top of the item prices (0 if prices already include VAT).
Tip: tip or service charge, 0 if none. totalCents: the grand total exactly as printed.`;

export class VisionReader implements ReceiptReader {
  constructor(private model: LanguageModel, private tracer?: Tracer, private billId = "unassigned") {}
  async read({ image, mediaType = "image/jpeg" }: { image?: Uint8Array; mediaType?: string }): Promise<ReceiptReadResult> {
    if (!image) throw new Error("VisionReader needs an image");
    const started = Date.now();
    const { output, usage } = await generateText({
      model: this.model,
      output: Output.object({ schema: ReadReceiptSchema }),
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "file", data: image, mediaType }] }],
    });
    const result = checkTotals(output, "vision");
    this.tracer?.log({
      billId: this.billId,
      step: "receipt.read",
      kind: "llm",
      args: { bytes: image.byteLength, mediaType },
      result: { items: result.items.length, totalCents: result.totalCents, mismatchCents: result.mismatchCents, usage, ms: Date.now() - started },
    });
    return result;
  }
}
