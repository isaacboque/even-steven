import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Cents } from "../core/money.js";
import type { Tracer } from "../trace/trace.js";

export type ActionKind = "create_request" | "send_reminder" | "cancel_request";
export type ProposedAction = {
  kind: ActionKind;
  billId: string;
  debtor?: string;
  creditor?: string;
  amountCents?: Cents;
  requestId?: string;
  memo?: string;
  reason: string;
};
export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed";
export type Approval = {
  id: string;
  action: ProposedAction;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  executedAt?: string;
  result?: unknown;
};

export class ApprovalQueue {
  private items = new Map<string, Approval>();
  private seq = 0;
  constructor(
    private tracer: Tracer,
    private opts: { file?: string; now?: () => Date } = {},
  ) {
    if (opts.file && existsSync(opts.file)) {
      const saved = JSON.parse(readFileSync(opts.file, "utf8")) as { seq: number; items: Approval[] };
      this.seq = saved.seq;
      saved.items.forEach((a) => this.items.set(a.id, a));
    }
  }
  private now() {
    return (this.opts.now ?? (() => new Date()))().toISOString();
  }
  private persist() {
    if (!this.opts.file) return;
    mkdirSync(dirname(this.opts.file), { recursive: true });
    writeFileSync(this.opts.file, JSON.stringify({ seq: this.seq, items: [...this.items.values()] }, null, 2));
  }

  propose(action: ProposedAction): Approval {
    const a: Approval = { id: `apr_${++this.seq}`, action, status: "pending", createdAt: this.now() };
    this.items.set(a.id, a);
    this.tracer.log({ billId: action.billId, step: "approval.proposed", kind: "approval", args: action, result: { id: a.id } });
    this.persist();
    return a;
  }
  decide(id: string, approve: boolean, by = "user", note?: string): Approval {
    const a = this.get(id);
    if (a.status !== "pending") throw new Error(`Approval ${id} is already ${a.status}`);
    a.status = approve ? "approved" : "rejected";
    a.decidedAt = this.now();
    a.decidedBy = by;
    a.decisionNote = note;
    this.tracer.log({ billId: a.action.billId, step: approve ? "approval.approved" : "approval.rejected", kind: "approval", args: { id, by, note } });
    this.persist();
    return a;
  }
  /** Gateways call this before moving money. Throws unless approved and not yet executed. */
  assertExecutable(id: string | undefined, kind: ActionKind): Approval {
    if (!id) throw new ApprovalRequiredError("No approval id given");
    const a = this.items.get(id);
    if (!a) throw new ApprovalRequiredError(`Unknown approval ${id}`);
    if (a.action.kind !== kind) throw new ApprovalRequiredError(`Approval ${id} is for ${a.action.kind}, not ${kind}`);
    if (a.status !== "approved") throw new ApprovalRequiredError(`Approval ${id} is ${a.status}`);
    return a;
  }
  markExecuted(id: string, result: unknown): void {
    const a = this.get(id);
    a.status = "executed";
    a.executedAt = this.now();
    a.result = result;
    this.persist();
  }
  get(id: string): Approval {
    const a = this.items.get(id);
    if (!a) throw new Error(`Unknown approval ${id}`);
    return a;
  }
  list(status?: ApprovalStatus): Approval[] {
    return [...this.items.values()].filter((a) => !status || a.status === status);
  }
}

export class ApprovalRequiredError extends Error {}
