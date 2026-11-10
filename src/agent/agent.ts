import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import type { ApprovalQueue, Approval } from "../approval/queue.js";
import type { PaymentsGateway } from "../gateway/PaymentsGateway.js";
import type { Tracer } from "../trace/trace.js";
import type { Bill } from "../bills/store.js";
import { settleBill } from "./settlement.js";
import { formatCents } from "../core/money.js";

export type AgentDeps = { approvals: ApprovalQueue; gateway: PaymentsGateway; tracer: Tracer; now?: () => Date };
export type AgentRun = { proposals: Approval[]; summary: string; mode: "llm" | "rules"; refused: string[] };

const SYSTEM = `You are Even Steven, an agent that settles a shared bill with PayPal payment requests.
You can only PROPOSE actions; a human approves each one before any money request is sent. Never claim something was sent.
Steps: 1) call get_settlement; 2) propose exactly one payment request per transfer in the settlement, with the exact amount
and a short, friendly reason; 3) call list_requests and propose a reminder only for requests that are still unpaid and older
than the reminder threshold. Do not propose anything twice. Finish with a two-sentence summary for the user.`;

/** Tools the model may call. Money tools only enqueue approvals; guardrails reject anything not in the settlement. */
export function buildTools(bill: Bill, deps: AgentDeps, out: { proposals: Approval[]; refused: string[] }, reminderAfterDays = 3) {
  const settlement = settleBill(bill);
  const proposedKeys = new Set(
    deps.approvals.list().filter((a) => a.action.billId === bill.id && a.status !== "rejected").map((a) => keyOf(a.action.kind, a.action.debtor ?? a.action.requestId ?? "", a.action.amountCents)),
  );
  const log = (step: string, args: unknown, result: unknown) => deps.tracer.log({ billId: bill.id, step, kind: "decision", args, result });
  const refuse = (why: string, args: unknown) => {
    out.refused.push(why);
    deps.tracer.log({ billId: bill.id, step: "agent.guardrail", kind: "error", args, error: why });
    return { ok: false, error: why };
  };

  return {
    get_settlement: tool({
      description: "Get who owes whom (fewest transfers), each person's share and the payer.",
      inputSchema: z.object({}),
      execute: async () => {
        const r = {
          currency: bill.receipt.currency,
          payer: settlement.payer,
          transfers: settlement.transfers.map((t) => ({ from: t.from, to: t.to, amountCents: t.amountCents, display: formatCents(t.amountCents, bill.receipt.currency) })),
          owed: settlement.owed,
        };
        log("agent.get_settlement", {}, r);
        return r;
      },
    }),
    propose_payment_request: tool({
      description: "Propose a PayPal payment request from a debtor to the payer. Needs human approval before it is sent.",
      inputSchema: z.object({ debtor: z.string(), amountCents: z.number().int(), reason: z.string().max(200) }),
      execute: async ({ debtor, amountCents, reason }) => {
        const t = settlement.transfers.find((x) => x.from === debtor);
        if (!t) return refuse(`${debtor} owes nothing in this settlement`, { debtor, amountCents });
        if (t.amountCents !== amountCents) return refuse(`Amount for ${debtor} must be ${t.amountCents} cents, not ${amountCents}`, { debtor, amountCents });
        const key = keyOf("create_request", debtor, amountCents);
        if (proposedKeys.has(key)) return refuse(`A request for ${debtor} was already proposed`, { debtor, amountCents });
        if (!bill.people.find((p) => p.name === debtor)?.email && deps.gateway.name !== "mock") return refuse(`No PayPal email for ${debtor}`, { debtor });
        proposedKeys.add(key);
        const a = deps.approvals.propose({ kind: "create_request", billId: bill.id, debtor, creditor: t.to, amountCents, memo: bill.merchant || "Shared bill", reason });
        out.proposals.push(a);
        return { ok: true, approvalId: a.id, status: "pending human approval" };
      },
    }),
    list_requests: tool({
      description: "List PayPal requests already sent for this bill, with status and age in days.",
      inputSchema: z.object({}),
      execute: async () => {
        const now = (deps.now ?? (() => new Date()))().getTime();
        const reqs = (await deps.gateway.list(bill.id)).map((r) => ({ requestId: r.id, debtor: r.debtor, status: r.status, amountCents: r.amountCents, ageDays: Math.floor((now - new Date(r.createdAt).getTime()) / 86400000), remindersSent: r.remindersSent }));
        log("agent.list_requests", {}, reqs);
        return { reminderAfterDays, requests: reqs };
      },
    }),
    propose_reminder: tool({
      description: "Propose a PayPal reminder for an unpaid request older than the threshold. Needs human approval.",
      inputSchema: z.object({ requestId: z.string(), reason: z.string().max(200) }),
      execute: async ({ requestId, reason }) => {
        const r = (await deps.gateway.list(bill.id)).find((x) => x.id === requestId);
        if (!r) return refuse(`Unknown request ${requestId}`, { requestId });
        if (r.status !== "sent") return refuse(`Request ${requestId} is ${r.status}; no reminder needed`, { requestId });
        const age = ((deps.now ?? (() => new Date()))().getTime() - new Date(r.createdAt).getTime()) / 86400000;
        if (age < reminderAfterDays) return refuse(`Request ${requestId} is only ${age.toFixed(1)} days old`, { requestId });
        const key = keyOf("send_reminder", requestId, r.remindersSent);
        if (proposedKeys.has(key)) return refuse(`Reminder for ${requestId} already proposed`, { requestId });
        proposedKeys.add(key);
        const a = deps.approvals.propose({ kind: "send_reminder", billId: bill.id, requestId, debtor: r.debtor, amountCents: r.amountCents, reason });
        out.proposals.push(a);
        return { ok: true, approvalId: a.id, status: "pending human approval" };
      },
    }),
  };
}

function keyOf(kind: string, who: string, n: number | undefined) {
  return `${kind}:${who}:${n ?? ""}`;
}

/** LLM agent: the model decides what to propose through the tools above. */
export async function runAgent(bill: Bill, model: LanguageModel, deps: AgentDeps, reminderAfterDays = 3): Promise<AgentRun> {
  const out = { proposals: [] as Approval[], refused: [] as string[] };
  deps.tracer.log({ billId: bill.id, step: "agent.start", kind: "llm", args: { mode: "llm" } });
  const res = await generateText({
    model,
    system: SYSTEM,
    prompt: `Bill ${bill.id} at ${bill.merchant || "a restaurant"}, total ${formatCents(bill.receipt.totalCents, bill.receipt.currency)}. Settle it.`,
    tools: buildTools(bill, deps, out, reminderAfterDays),
    stopWhen: stepCountIs(10),
  });
  deps.tracer.log({ billId: bill.id, step: "agent.finish", kind: "llm", result: { text: res.text, steps: res.steps.length, usage: res.totalUsage } });
  return { proposals: out.proposals, summary: res.text, mode: "llm", refused: out.refused };
}

/** No-LLM fallback (demo mode without keys): same tools, deterministic choices. */
export async function runRulesAgent(bill: Bill, deps: AgentDeps, reminderAfterDays = 3): Promise<AgentRun> {
  const out = { proposals: [] as Approval[], refused: [] as string[] };
  const tools = buildTools(bill, deps, out, reminderAfterDays);
  const call = <T>(t: { execute?: (...a: never[]) => unknown }, args: unknown) => (t.execute as unknown as (a: unknown, o: unknown) => Promise<T>)(args, { toolCallId: "rules", messages: [] });
  deps.tracer.log({ billId: bill.id, step: "agent.start", kind: "decision", args: { mode: "rules" } });
  const s = await call<{ transfers: { from: string; amountCents: number; display: string }[]; payer: string }>(tools.get_settlement, {});
  const existing = new Set((await deps.gateway.list(bill.id)).map((r) => r.debtor));
  for (const t of s.transfers) {
    if (existing.has(t.from)) continue;
    await call(tools.propose_payment_request, { debtor: t.from, amountCents: t.amountCents, reason: `${t.from}'s share of the bill (${t.display}) to ${s.payer}` });
  }
  const l = await call<{ requests: { requestId: string; status: string; ageDays: number }[] }>(tools.list_requests, {});
  for (const r of l.requests) if (r.status === "sent" && r.ageDays >= reminderAfterDays) await call(tools.propose_reminder, { requestId: r.requestId, reason: `Unpaid after ${r.ageDays} days` });
  const summary = `Proposed ${out.proposals.length} action(s) for approval. Nothing is sent until you approve it.`;
  deps.tracer.log({ billId: bill.id, step: "agent.finish", kind: "decision", result: { summary } });
  return { proposals: out.proposals, summary, mode: "rules", refused: out.refused };
}
