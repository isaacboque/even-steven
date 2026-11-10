import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryTracer, JsonlTracer } from "../src/trace/trace.js";
import { ApprovalQueue, ApprovalRequiredError } from "../src/approval/queue.js";
import { MockGateway } from "../src/gateway/MockGateway.js";
import { idempotencyKey } from "../src/gateway/PaymentsGateway.js";

let tracer: MemoryTracer, approvals: ApprovalQueue, gw: MockGateway;
const input = (approvalId: string) => ({
  billId: "b1", debtor: "ben", creditor: "ana", amountCents: 1250, currency: "EUR", memo: "dinner",
  idempotencyKey: idempotencyKey("b1", "ben", "ana", 1250), approvalId,
});
const proposeCreate = () => approvals.propose({ kind: "create_request", billId: "b1", debtor: "ben", creditor: "ana", amountCents: 1250, reason: "ben owes ana" });

beforeEach(() => {
  tracer = new MemoryTracer();
  approvals = new ApprovalQueue(tracer);
  gw = new MockGateway(approvals, tracer);
});

describe("approval gate", () => {
  it("refuses without approval", async () => {
    await expect(gw.createRequest(input(""))).rejects.toThrow(ApprovalRequiredError);
    const a = proposeCreate();
    await expect(gw.createRequest(input(a.id))).rejects.toThrow(/pending/);
    expect(gw.providerCreates).toBe(0);
    expect(tracer.events.some((e) => e.step === "gateway.create.refused")).toBe(true);
  });
  it("refuses a rejected approval", async () => {
    const a = proposeCreate();
    approvals.decide(a.id, false, "isaac", "wrong amount");
    await expect(gw.createRequest(input(a.id))).rejects.toThrow(/rejected/);
  });
  it("creates once after approval and is idempotent", async () => {
    const a = proposeCreate();
    approvals.decide(a.id, true);
    const r1 = await gw.createRequest(input(a.id));
    const r2 = await gw.createRequest(input(a.id));
    expect(r1.id).toBe(r2.id);
    expect(gw.providerCreates).toBe(1);
    expect(approvals.get(a.id).status).toBe("executed");
  });
  it("an approval cannot be reused for a different action", async () => {
    const a = proposeCreate();
    approvals.decide(a.id, true);
    const r = await gw.createRequest(input(a.id));
    await expect(gw.sendReminder(r.id, a.id)).rejects.toThrow(/create_request/);
  });
});

describe("reminders", () => {
  it("only reminds unpaid requests", async () => {
    const a = proposeCreate();
    approvals.decide(a.id, true);
    const r = await gw.createRequest(input(a.id));
    const rem = approvals.propose({ kind: "send_reminder", billId: "b1", requestId: r.id, reason: "unpaid after 3 days" });
    approvals.decide(rem.id, true);
    expect((await gw.sendReminder(r.id, rem.id)).remindersSent).toBe(1);
    gw.markPaid(r.id);
    const rem2 = approvals.propose({ kind: "send_reminder", billId: "b1", requestId: r.id, reason: "again" });
    approvals.decide(rem2.id, true);
    await expect(gw.sendReminder(r.id, rem2.id)).rejects.toThrow(/paid/);
  });
});

describe("traces", () => {
  it("writes and reads JSONL per bill", () => {
    const dir = mkdtempSync(join(tmpdir(), "es-"));
    const t = new JsonlTracer(dir);
    t.log({ billId: "b1", step: "x", kind: "decision", result: 1 });
    t.log({ billId: "b2", step: "y", kind: "tool" });
    expect(t.read("b1")).toHaveLength(1);
    expect(t.read("b1")[0].step).toBe("x");
    expect(() => t.log({ billId: "../evil", step: "z", kind: "tool" })).toThrow();
  });
  it("approval queue persists to a file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "es-")), "approvals.json");
    const q1 = new ApprovalQueue(new MemoryTracer(), { file });
    const a = q1.propose({ kind: "create_request", billId: "b1", reason: "r" });
    const q2 = new ApprovalQueue(new MemoryTracer(), { file });
    expect(q2.get(a.id).status).toBe("pending");
  });
});
