import { describe, it, expect, beforeEach } from "vitest";
import { createApp, type AppDeps } from "../src/server/app.js";
import { BillStore } from "../src/bills/store.js";
import { ApprovalQueue } from "../src/approval/queue.js";
import { MemoryTracer } from "../src/trace/trace.js";
import { MockGateway } from "../src/gateway/MockGateway.js";
import { FixtureReader } from "../src/receipt/FixtureReader.js";
import { scriptedModel } from "./helpers/mockModel.js";
import { settleBill } from "../src/agent/settlement.js";

let deps: AppDeps, app: ReturnType<typeof createApp>, gw: MockGateway, offset = 0;
function setup(model?: AppDeps["model"]) {
  offset = 0;
  const now = () => new Date(Date.UTC(2026, 10, 12) + offset);
  const tracer = new MemoryTracer(now);
  const approvals = new ApprovalQueue(tracer, { now });
  gw = new MockGateway(approvals, tracer, now);
  deps = { bills: new BillStore(), approvals, gateway: gw, tracer, fixtures: new FixtureReader(), model, clock: { now, advanceDays: (d) => (offset += d * 86400000), reset: () => (offset = 0) } };
  app = createApp(deps);
}
const json = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

async function bill() {
  const b = await (await app.request("/api/bills", json("POST", { fixtureId: "restaurant-4" }))).json();
  const items = b.receipt.items as { id: string }[];
  const people = ["Ana", "Ben", "Cai", "Dani"].map((name) => ({ name, email: `${name.toLowerCase()}@example.com` }));
  const assignment = Object.fromEntries(items.map((it, i) => [it.id, i === 3 ? ["Ana", "Ben", "Cai", "Dani"] : [people[i % 4].name]]));
  const r = await app.request(`/api/bills/${b.id}/assignment`, json("PUT", { people, payer: "Ana", assignment }));
  expect(r.status).toBe(200);
  return b.id as string;
}

describe("demo reset", () => {
  beforeEach(() => setup());
  it("clears bills, approvals, requests, idempotency store and the clock after a full flow", async () => {
    const id = await bill();
    const run = await (await app.request(`/api/bills/${id}/propose`, json("POST"))).json();
    await app.request(`/api/approvals/${run.proposals[0].id}/approve`, json("POST"));
    await app.request("/api/dev/advance", json("POST", { days: 5 }));
    expect(gw.providerCreates).toBe(1);

    const r = await app.request("/api/dev/reset", json("POST"));
    expect(r.status).toBe(200);
    expect(await (await app.request("/api/bills")).json()).toEqual([]);
    expect(await (await app.request("/api/approvals")).json()).toEqual([]);
    expect(await gw.list()).toEqual([]);
    expect(deps.clock.now().toISOString()).toBe(new Date(Date.UTC(2026, 10, 12)).toISOString());

    // same bill + same payment can be created again (idempotency store was cleared)
    const id2 = await bill();
    const run2 = await (await app.request(`/api/bills/${id2}/propose`, json("POST"))).json();
    expect(run2.proposals).toHaveLength(3);
    const before = gw.providerCreates;
    await app.request(`/api/approvals/${run2.proposals[0].id}/approve`, json("POST"));
    expect(gw.providerCreates).toBe(before + 1);
  });
  it("is a 404 when the gateway is not the mock (paypal mode)", async () => {
    const fake = { name: "paypal", createRequest: gw.createRequest, sendReminder: gw.sendReminder, cancel: gw.cancel, getStatus: gw.getStatus, list: gw.list } as unknown as AppDeps["gateway"];
    const paypalApp = createApp({ ...deps, gateway: fake, clock: { now: deps.clock.now } });
    await bill();
    expect((await paypalApp.request("/api/dev/reset", json("POST"))).status).toBe(404);
    expect((await paypalApp.request("/api/bills")).status).toBe(200);
    expect(((await (await paypalApp.request("/api/bills")).json()) as unknown[]).length).toBe(1); // nothing cleared
  });
});

describe("API flow with the rules agent", () => {
  beforeEach(() => setup());
  it("receipt → settlement → proposals → approve executes once → reject executes nothing", async () => {
    const id = await bill();
    const s = await (await app.request(`/api/bills/${id}/settlement`)).json();
    expect(s.transfers.length).toBe(3);
    const run = await (await app.request(`/api/bills/${id}/propose`, json("POST"))).json();
    expect(run.proposals).toHaveLength(3);
    expect(gw.providerCreates).toBe(0); // nothing sent yet

    const [a1, a2] = run.proposals;
    expect((await app.request(`/api/approvals/${a1.id}/approve`, json("POST"))).status).toBe(200);
    expect((await app.request(`/api/approvals/${a1.id}/approve`, json("POST"))).status).toBe(400); // second approve refused
    await app.request(`/api/approvals/${a2.id}/reject`, json("POST", { note: "wrong person" }));
    expect(gw.providerCreates).toBe(1);

    // re-proposing does not duplicate the pending or executed ones
    const again = await (await app.request(`/api/bills/${id}/propose`, json("POST"))).json();
    expect(again.proposals.map((p: { action: { debtor: string } }) => p.action.debtor)).toEqual([a2.action.debtor]);

    const trace = await (await app.request(`/api/bills/${id}/trace`)).json();
    const steps = trace.map((e: { step: string }) => e.step);
    for (const s of ["bill.created", "bill.assigned", "agent.get_settlement", "approval.proposed", "approval.approved", "gateway.create", "approval.rejected"]) expect(steps).toContain(s);
  });
  it("reminders only after the threshold and only for unpaid", async () => {
    const id = await bill();
    const run = await (await app.request(`/api/bills/${id}/propose`, json("POST"))).json();
    for (const p of run.proposals) await app.request(`/api/approvals/${p.id}/approve`, json("POST"));
    const reqs = await (await app.request(`/api/bills/${id}/requests`)).json();
    await app.request(`/api/dev/paid/${reqs[0].id}`, json("POST"));
    let r = await (await app.request(`/api/bills/${id}/propose`, json("POST"))).json();
    expect(r.proposals).toHaveLength(0);
    await app.request(`/api/dev/advance`, json("POST", { days: 4 }));
    r = await (await app.request(`/api/bills/${id}/propose`, json("POST"))).json();
    expect(r.proposals.map((p: { action: { kind: string } }) => p.action.kind)).toEqual(["send_reminder", "send_reminder"]);
  });
  it("blocks splitting a receipt that does not add up", async () => {
    const b = await (await app.request("/api/bills", json("POST", { fixtureId: "one-cent-off" }))).json();
    expect(b.mismatchCents).toBe(1);
    expect((await app.request(`/api/bills/${b.id}/settlement`)).status).toBe(422);
  });
  it("photo upload without an LLM key is a clear error", async () => {
    const fd = new FormData();
    fd.append("image", new File([new Uint8Array([1])], "r.jpg", { type: "image/jpeg" }));
    const r = await app.request("/api/bills", { method: "POST", body: fd });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/LLM key/);
  });
});

describe("LLM agent (scripted mock model)", () => {
  it("proposes through tools; guardrails refuse wrong amounts and duplicates; never sends", async () => {
    setup();
    const id = await bill();
    const transfers = settleBill(deps.bills.get(id)).transfers;
    const model = scriptedModel([
      { tools: [{ name: "get_settlement", input: {} }] },
      {
        tools: [
          ...transfers.map((t) => ({ name: "propose_payment_request", input: { debtor: t.from, amountCents: t.amountCents, reason: "share" } })),
          { name: "propose_payment_request", input: { debtor: transfers[0].from, amountCents: transfers[0].amountCents + 100, reason: "oops" } },
          { name: "propose_payment_request", input: { debtor: transfers[0].from, amountCents: transfers[0].amountCents, reason: "dup" } },
        ],
      },
      { text: "Proposed 3 requests for your approval." },
    ]);
    deps.model = model;
    app = createApp(deps);
    const run = await (await app.request(`/api/bills/${id}/propose`, json("POST"))).json();
    expect(run.mode).toBe("llm");
    expect(run.proposals).toHaveLength(transfers.length);
    expect(run.refused).toHaveLength(2);
    expect(gw.providerCreates).toBe(0);
    expect(run.summary).toMatch(/approval/);
  });
});
