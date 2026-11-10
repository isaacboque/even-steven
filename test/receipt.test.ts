import { describe, it, expect } from "vitest";
import { FixtureReader } from "../src/receipt/FixtureReader.js";
import { VisionReader } from "../src/receipt/VisionReader.js";
import { MemoryTracer } from "../src/trace/trace.js";
import { textModel } from "./helpers/mockModel.js";
import { modelFromEnv } from "../src/llm/model.js";

describe("FixtureReader", () => {
  const r = new FixtureReader();
  it("lists the 5 fixtures", () => {
    expect(r.list()).toHaveLength(5);
  });
  it("valid fixtures add up, the broken one reports the mismatch", async () => {
    for (const id of r.list()) {
      const res = await r.read({ fixtureId: id });
      expect(res.mismatchCents).toBe(id === "one-cent-off" ? 1 : 0);
    }
  });
  it("rejects path tricks", async () => {
    await expect(r.read({ fixtureId: "../package" })).rejects.toThrow();
  });
});

describe("VisionReader", () => {
  it("parses the model output, checks totals and traces the call", async () => {
    const answer = JSON.stringify({
      merchant: "Cafe", currency: "EUR",
      items: [{ name: "Tea", qty: 2, unitCents: 150, totalCents: 300 }],
      taxCents: 0, tipCents: 0, totalCents: 305,
    });
    const model = textModel(answer);
    const tracer = new MemoryTracer();
    const res = await new VisionReader(model, tracer, "b1").read({ image: new Uint8Array([1, 2, 3]) });
    expect(res.items[0].name).toBe("Tea");
    expect(res.mismatchCents).toBe(5);
    expect(res.source).toBe("vision");
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(tracer.events[0]).toMatchObject({ step: "receipt.read", kind: "llm", billId: "b1" });
  });
  it("needs an image", async () => {
    await expect(new VisionReader(textModel("{}")).read({})).rejects.toThrow(/image/);
  });
});

describe("modelFromEnv", () => {
  it("builds each provider without network", () => {
    for (const p of ["google", "openai", "anthropic"]) expect(modelFromEnv({ LLM_PROVIDER: p, LLM_MODEL: "x" })).toBeTruthy();
    expect(() => modelFromEnv({ LLM_PROVIDER: "nope" })).toThrow();
  });
});
