import { Hono } from "hono";
import type { LanguageModel } from "ai";
import { BillStore, NotFound, type Person } from "../bills/store.js";
import type { ApprovalQueue } from "../approval/queue.js";
import type { PaymentsGateway } from "../gateway/PaymentsGateway.js";
import { MockGateway } from "../gateway/MockGateway.js";
import { idempotencyKey } from "../gateway/PaymentsGateway.js";
import type { Tracer } from "../trace/trace.js";
import type { ReceiptReader } from "../receipt/types.js";
import type { FixtureReader } from "../receipt/FixtureReader.js";
import { settleBill } from "../agent/settlement.js";
import { runAgent, runRulesAgent } from "../agent/agent.js";
import { SplitError } from "../core/split.js";

export type AppDeps = {
  bills: BillStore;
  approvals: ApprovalQueue;
  gateway: PaymentsGateway;
  tracer: Tracer;
  fixtures: FixtureReader;
  vision?: (billHint: string) => ReceiptReader;
  model?: LanguageModel;
  clock: { now: () => Date; advanceDays?: (d: number) => void };
  reminderAfterDays?: number;
};

export function createApp(d: AppDeps) {
  const app = new Hono();
  const reminderAfterDays = d.reminderAfterDays ?? 3;

  app.onError((err, c) => {
    const status = err instanceof NotFound ? 404 : err instanceof SplitError ? 422 : 400;
    return c.json({ error: err.message }, status);
  });

  app.get("/api/config", (c) =>
    c.json({ gateway: d.gateway.name, agent: d.model ? "llm" : "rules", vision: Boolean(d.vision), fixtures: d.fixtures.list(), reminderAfterDays, now: d.clock.now().toISOString() }),
  );

  // 1. receipt → bill
  app.post("/api/bills", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    let read;
    if (ct.includes("multipart/form-data")) {
      if (!d.vision) throw new Error("Receipt photos need an LLM key (set LLM_PROVIDER and its API key). Use a sample receipt instead.");
      const form = await c.req.formData();
      const file = form.get("image");
      if (!(file instanceof File)) throw new Error("Send the photo in the 'image' field");
      read = await d.vision("new").read({ image: new Uint8Array(await file.arrayBuffer()), mediaType: file.type || "image/jpeg" });
    } else {
      const body = (await c.req.json()) as { fixtureId?: string };
      read = await d.fixtures.read({ fixtureId: body.fixtureId });
    }
    const bill = d.bills.create({
      merchant: read.merchant,
      receipt: {
        currency: read.currency,
        items: read.items.map((it, i) => ({ id: `i${i}`, name: it.qty > 1 ? `${it.name} x${it.qty}` : it.name, totalCents: it.totalCents })),
        taxCents: read.taxCents,
        tipCents: read.tipCents,
        totalCents: read.totalCents,
      },
      mismatchCents: read.mismatchCents,
      people: [],
      assignment: {},
    });
    d.tracer.log({ billId: bill.id, step: "bill.created", kind: "decision", args: { source: read.source }, result: { items: bill.receipt.items.length, totalCents: bill.receipt.totalCents, mismatchCents: read.mismatchCents } });
    return c.json(bill, 201);
  });

  app.get("/api/bills", (c) => c.json(d.bills.list()));
  app.get("/api/bills/:id", (c) => c.json(d.bills.get(c.req.param("id"))));

  // 2. user corrects items (mismatch must reach 0)
  app.put("/api/bills/:id/items", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as { items: { id: string; name: string; totalCents: number }[]; taxCents: number; tipCents: number; totalCents: number };
    for (const it of body.items) if (!Number.isInteger(it.totalCents)) throw new Error(`Item ${it.name}: amount must be in cents`);
    const receipt = { ...d.bills.get(id).receipt, items: body.items, taxCents: body.taxCents, tipCents: body.tipCents, totalCents: body.totalCents };
    const mismatchCents = receipt.totalCents - (receipt.items.reduce((a, i) => a + i.totalCents, 0) + receipt.taxCents + receipt.tipCents);
    d.tracer.log({ billId: id, step: "bill.items_edited", kind: "decision", result: { items: body.items.length, mismatchCents } });
    return c.json(d.bills.update(id, { receipt, mismatchCents }));
  });

  // 3. people, payer and who had what
  app.put("/api/bills/:id/assignment", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as { people: Person[]; payer: string; assignment: Record<string, string[]> };
    const names = new Set(body.people.map((p) => p.name));
    if (!names.has(body.payer)) throw new Error("The payer must be one of the people");
    for (const [item, who] of Object.entries(body.assignment)) for (const p of who) if (!names.has(p)) throw new Error(`Unknown person ${p} on item ${item}`);
    d.tracer.log({ billId: id, step: "bill.assigned", kind: "decision", args: { people: body.people.map((p) => p.name), payer: body.payer } });
    return c.json(d.bills.update(id, { people: body.people, payer: body.payer, assignment: body.assignment }));
  });

  app.get("/api/bills/:id/settlement", (c) => {
    const bill = d.bills.get(c.req.param("id"));
    if (bill.mismatchCents !== 0) throw new SplitError(`Fix the receipt first: it is off by ${bill.mismatchCents} cents`);
    return c.json(settleBill(bill));
  });

  // 4. agent proposes; nothing moves without approval
  app.post("/api/bills/:id/propose", async (c) => {
    const bill = d.bills.get(c.req.param("id"));
    if (bill.mismatchCents !== 0) throw new SplitError(`Fix the receipt first: it is off by ${bill.mismatchCents} cents`);
    const deps = { approvals: d.approvals, gateway: d.gateway, tracer: d.tracer, now: d.clock.now };
    const run = d.model ? await runAgent(bill, d.model, deps, reminderAfterDays) : await runRulesAgent(bill, deps, reminderAfterDays);
    return c.json(run);
  });

  app.get("/api/approvals", (c) => {
    const billId = c.req.query("billId");
    return c.json(d.approvals.list().filter((a) => !billId || a.action.billId === billId).reverse());
  });

  app.post("/api/approvals/:id/reject", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    return c.json(d.approvals.decide(c.req.param("id"), false, "user", body.note));
  });

  /** Approve = the human decision; the server (not the model) then executes it once through the gateway. */
  app.post("/api/approvals/:id/approve", async (c) => {
    const a = d.approvals.decide(c.req.param("id"), true, "user");
    const act = a.action;
    let result;
    try {
      if (act.kind === "create_request") {
        const bill = d.bills.get(act.billId);
        const debtorEmail = bill.people.find((p) => p.name === act.debtor)?.email;
        result = await d.gateway.createRequest({
          billId: act.billId, debtor: act.debtor!, debtorEmail, creditor: act.creditor!, amountCents: act.amountCents!,
          currency: bill.receipt.currency, memo: act.memo ?? "Shared bill",
          idempotencyKey: idempotencyKey(act.billId, act.debtor!, act.creditor!, act.amountCents!), approvalId: a.id,
        });
      } else if (act.kind === "send_reminder") {
        result = await d.gateway.sendReminder(act.requestId!, a.id);
      } else {
        result = await d.gateway.cancel(act.requestId!, a.id);
      }
    } catch (e) {
      d.tracer.log({ billId: act.billId, step: "approval.execute_failed", kind: "error", args: { id: a.id }, error: (e as Error).message });
      throw e;
    }
    return c.json({ approval: d.approvals.get(a.id), result });
  });

  app.get("/api/bills/:id/requests", async (c) => {
    const id = c.req.param("id");
    const reqs = await d.gateway.list(id);
    return c.json(await Promise.all(reqs.map((r) => d.gateway.getStatus(r.id).catch(() => r))));
  });

  app.get("/api/bills/:id/trace", (c) => c.json(d.tracer.read(c.req.param("id"))));

  // demo helpers (mock gateway only): simulate time passing and a debtor paying
  app.post("/api/dev/advance", async (c) => {
    if (!d.clock.advanceDays) throw new Error("Clock control is only available in mock mode");
    const { days = 1 } = (await c.req.json().catch(() => ({}))) as { days?: number };
    d.clock.advanceDays(days);
    return c.json({ now: d.clock.now().toISOString() });
  });
  app.post("/api/dev/paid/:requestId", (c) => {
    if (!(d.gateway instanceof MockGateway)) throw new Error("Only in mock mode: pay the invoice in the PayPal sandbox instead");
    return c.json(d.gateway.markPaid(c.req.param("requestId")));
  });

  return app;
}
