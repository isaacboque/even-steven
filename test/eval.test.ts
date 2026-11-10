import { describe, it, expect } from "vitest";
import { runAll } from "../src/eval/run.js";
import { buildScenarios } from "../src/eval/scenarios.js";

describe("eval harness", () => {
  it("has 20 scenarios covering 2–8 people", () => {
    const s = buildScenarios();
    expect(s).toHaveLength(20);
    expect(new Set(s.map((x) => Object.keys(x.assignment).length > 0)).size).toBe(1);
  });
  it("all 20 pass every check", async () => {
    const res = await runAll();
    const failed = res.filter((r) => Object.values(r.checks).some((v) => !v));
    expect(failed.map((f) => ({ id: f.id, checks: f.checks, notes: f.notes }))).toEqual([]);
  });
});
