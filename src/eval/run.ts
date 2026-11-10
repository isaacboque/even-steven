import { splitReceipt } from "../core/split.js";
import { minTransfers, exactTransfers, applyTransfers } from "../core/settle.js";
import { MemoryTracer } from "../trace/trace.js";
import { ApprovalQueue } from "../approval/queue.js";
import { MockGateway } from "../gateway/MockGateway.js";
import { idempotencyKey } from "../gateway/PaymentsGateway.js";
import { buildScenarios, type Scenario } from "./scenarios.js";

export type Check = "sumsToTotal" | "minimalTransfers" | "settlesToZero" | "noDuplicates" | "approvalEnforced" | "remindersCorrect";
export type ScenarioResult = { id: string; title: string; transfers: number; checks: Record<Check, boolean>; notes: string[] };

export async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const notes: string[] = [];
  let clock = new Date("2026-11-12T12:00:00Z");
  const now = () => clock;
  const tracer = new MemoryTracer(now);
  const approvals = new ApprovalQueue(tracer, { now });
  const gw = new MockGateway(approvals, tracer, now);
  const billId = s.id;

  // 1. split + settle: the payer paid the whole receipt
  const split = splitReceipt(s.receipt, s.assignment);
  const owedSum = Object.values(split.owed).reduce((a, b) => a + b, 0);
  const balances: Record<string, number> = {};
  for (const [p, c] of Object.entries(split.owed)) balances[p] = -c;
  balances[s.payer] = (balances[s.payer] ?? 0) + s.receipt.totalCents;
  const settlement = minTransfers(balances);
  const optimum = exactTransfers(balances).length;

  // 2. propose one request per transfer; try to execute before approval when the scenario says so
  let approvalEnforced = true;
  let createdBeforeApproval = 0;
  const reqIds: Record<string, string> = {};
  for (const t of settlement.transfers) {
    const a = approvals.propose({ kind: "create_request", billId, debtor: t.from, creditor: t.to, amountCents: t.amountCents, reason: "settlement" });
    const input = { billId, debtor: t.from, creditor: t.to, amountCents: t.amountCents, currency: "EUR", memo: s.title, idempotencyKey: idempotencyKey(billId, t.from, t.to, t.amountCents), approvalId: a.id };
    if (s.tryWithoutApproval) {
      try {
        await gw.createRequest(input);
        createdBeforeApproval++;
      } catch {
        /* expected */
      }
    }
    approvals.decide(a.id, true, "eval");
    for (let i = 0; i <= s.createRetries; i++) reqIds[t.from] = (await gw.createRequest(input)).id;
  }
  if (createdBeforeApproval > 0) {
    approvalEnforced = false;
    notes.push(`${createdBeforeApproval} created without approval`);
  }
  const noDuplicates = gw.providerCreates === settlement.transfers.length;

  // 3. some pay right away; advance the clock; remind only unpaid requests older than the threshold
  for (const p of s.paysImmediately) if (reqIds[p]) gw.markPaid(reqIds[p]);
  clock = new Date(clock.getTime() + s.clockDays * 86400000);
  let remindersCorrect = true;
  for (const r of await gw.list(billId)) {
    const ageDays = (clock.getTime() - new Date(r.createdAt).getTime()) / 86400000;
    const shouldRemind = r.status === "sent" && ageDays >= s.reminderAfterDays;
    if (shouldRemind) {
      const a = approvals.propose({ kind: "send_reminder", billId, requestId: r.id, reason: `unpaid after ${ageDays} days` });
      approvals.decide(a.id, true, "eval");
      await gw.sendReminder(r.id, a.id);
    }
    const reminded = (await gw.getStatus(r.id)).remindersSent > 0;
    if (reminded !== shouldRemind) remindersCorrect = false;
  }

  return {
    id: s.id,
    title: s.title,
    transfers: settlement.transfers.length,
    checks: {
      sumsToTotal: owedSum === s.receipt.totalCents,
      minimalTransfers: settlement.transfers.length === optimum,
      settlesToZero: Object.values(applyTransfers(balances, settlement.transfers)).every((v) => v === 0),
      noDuplicates,
      approvalEnforced,
      remindersCorrect,
    },
    notes,
  };
}

export async function runAll(): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const s of buildScenarios()) out.push(await runScenario(s));
  return out;
}

export function toMarkdown(results: ScenarioResult[]): string {
  const checks: Check[] = ["sumsToTotal", "minimalTransfers", "settlesToZero", "noDuplicates", "approvalEnforced", "remindersCorrect"];
  const passed = results.filter((r) => checks.every((c) => r.checks[c])).length;
  const head = `| Scenario | Setup | Transfers | ${checks.join(" | ")} |\n|---|---|---|${checks.map(() => "---").join("|")}|`;
  const rows = results.map((r) => `| ${r.id} | ${r.title} | ${r.transfers} | ${checks.map((c) => (r.checks[c] ? "✅" : "❌")).join(" | ")} |`);
  return `**${passed}/${results.length} scenarios pass all checks.**\n\n${head}\n${rows.join("\n")}\n`;
}
