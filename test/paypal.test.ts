import { describe, it, expect, beforeEach } from "vitest";
import { MemoryTracer } from "../src/trace/trace.js";
import { ApprovalQueue } from "../src/approval/queue.js";
import { PayPalGateway, extractInvoiceId, mapStatus, type ToolInvoker } from "../src/gateway/PayPalGateway.js";
import { idempotencyKey } from "../src/gateway/PaymentsGateway.js";

class FakeTools implements ToolInvoker {
  calls: { tool: string; params: Record<string, unknown> }[] = [];
  status = "SENT";
  async call(tool: string, params: Record<string, unknown>) {
    this.calls.push({ tool, params });
    if (tool === "create_invoice") return JSON.stringify({ rel: "self", href: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-AAAA-BBBB-CCCC-DDDD" });
    if (tool === "get_invoice") return JSON.stringify({ id: params.invoice_id, status: this.status });
    return JSON.stringify({ ok: true });
  }
}

let tools: FakeTools, approvals: ApprovalQueue, gw: PayPalGateway, tracer: MemoryTracer;
beforeEach(() => {
  tracer = new MemoryTracer();
  tools = new FakeTools();
  approvals = new ApprovalQueue(tracer);
  gw = new PayPalGateway(tools, approvals, tracer);
});
const create = (approvalId: string) =>
  gw.createRequest({ billId: "b1", debtor: "ben", debtorEmail: "ben@example.com", creditor: "ana", amountCents: 1234, currency: "EUR", memo: "dinner", idempotencyKey: idempotencyKey("b1", "ben", "ana", 1234), approvalId });

describe("PayPalGateway", () => {
  it("never calls PayPal without approval", async () => {
    const a = approvals.propose({ kind: "create_request", billId: "b1", reason: "r" });
    await expect(create(a.id)).rejects.toThrow(/pending/);
    expect(tools.calls).toHaveLength(0);
  });
  it("creates and sends one invoice with the right amount, idempotently", async () => {
    const a = approvals.propose({ kind: "create_request", billId: "b1", reason: "r" });
    approvals.decide(a.id, true);
    const r = await create(a.id);
    await create(a.id);
    expect(r.id).toBe("INV2-AAAA-BBBB-CCCC-DDDD");
    expect(tools.calls.map((c) => c.tool)).toEqual(["create_invoice", "send_invoice"]);
    const items = tools.calls[0].params.items as { unit_amount: { value: string } }[];
    expect(items[0].unit_amount.value).toBe("12.34");
    expect(tracer.events.some((e) => e.step === "paypal.create_invoice")).toBe(true);
  });
  it("maps PayPal status and refuses reminders for paid invoices", async () => {
    const a = approvals.propose({ kind: "create_request", billId: "b1", reason: "r" });
    approvals.decide(a.id, true);
    const r = await create(a.id);
    tools.status = "PAID";
    const rem = approvals.propose({ kind: "send_reminder", billId: "b1", requestId: r.id, reason: "r" });
    approvals.decide(rem.id, true);
    await expect(gw.sendReminder(r.id, rem.id)).rejects.toThrow(/paid/);
  });
});

describe("helpers", () => {
  it("extracts invoice ids from every response shape", () => {
    expect(extractInvoiceId({ id: "INV2-1" })).toBe("INV2-1");
    expect(extractInvoiceId({ links: [{ rel: "self", href: "x/INV2-2" }] })).toBe("INV2-2");
    expect(extractInvoiceId('{"href":"x/INV2-3"}')).toBe("INV2-3");
    expect(() => extractInvoiceId({})).toThrow();
  });
  it("maps statuses", () => {
    expect(mapStatus("MARKED_AS_PAID", "sent")).toBe("paid");
    expect(mapStatus("CANCELLED", "sent")).toBe("cancelled");
    expect(mapStatus(undefined, "sent")).toBe("sent");
  });
});
