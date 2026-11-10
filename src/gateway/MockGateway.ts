import type { ApprovalQueue } from "../approval/queue.js";
import type { Tracer } from "../trace/trace.js";
import type { CreateRequestInput, PaymentRequest, PaymentsGateway } from "./PaymentsGateway.js";

/** In-memory PayPal stand-in for demos, tests and the eval harness. Same rules as the real gateway. */
export class MockGateway implements PaymentsGateway {
  readonly name = "mock";
  private requests = new Map<string, PaymentRequest>();
  private byKey = new Map<string, string>();
  private seq = 0;
  /** Count of real create calls that reached the "provider" (duplicates never get here). */
  providerCreates = 0;

  constructor(
    private approvals: ApprovalQueue,
    private tracer: Tracer,
    private now: () => Date = () => new Date(),
  ) {}

  async createRequest(input: CreateRequestInput): Promise<PaymentRequest> {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) {
      const r = this.requests.get(existing)!;
      this.tracer.log({ billId: input.billId, step: "gateway.create.duplicate", kind: "tool", args: input, result: { id: r.id } });
      return r;
    }
    this.guard(input.billId, "create", () => this.approvals.assertExecutable(input.approvalId, "create_request"));
    const r: PaymentRequest = {
      id: `MOCK-INV-${++this.seq}`,
      billId: input.billId,
      debtor: input.debtor,
      creditor: input.creditor,
      amountCents: input.amountCents,
      currency: input.currency,
      memo: input.memo,
      idempotencyKey: input.idempotencyKey,
      status: "sent",
      createdAt: this.now().toISOString(),
      remindersSent: 0,
    };
    this.providerCreates++;
    this.requests.set(r.id, r);
    this.byKey.set(input.idempotencyKey, r.id);
    this.approvals.markExecuted(input.approvalId, { requestId: r.id });
    this.tracer.log({ billId: input.billId, step: "gateway.create", kind: "tool", args: input, result: r });
    return r;
  }

  async sendReminder(requestId: string, approvalId: string): Promise<PaymentRequest> {
    const r = this.get(requestId);
    this.guard(r.billId, "remind", () => this.approvals.assertExecutable(approvalId, "send_reminder"));
    if (r.status !== "sent") {
      this.tracer.log({ billId: r.billId, step: "gateway.remind.skipped", kind: "tool", args: { requestId }, error: `status is ${r.status}` });
      throw new Error(`Cannot remind: request ${requestId} is ${r.status}`);
    }
    r.remindersSent++;
    r.lastReminderAt = this.now().toISOString();
    this.approvals.markExecuted(approvalId, { requestId });
    this.tracer.log({ billId: r.billId, step: "gateway.remind", kind: "tool", args: { requestId }, result: r });
    return r;
  }

  async cancel(requestId: string, approvalId: string): Promise<PaymentRequest> {
    const r = this.get(requestId);
    this.guard(r.billId, "cancel", () => this.approvals.assertExecutable(approvalId, "cancel_request"));
    r.status = "cancelled";
    this.approvals.markExecuted(approvalId, { requestId });
    this.tracer.log({ billId: r.billId, step: "gateway.cancel", kind: "tool", args: { requestId }, result: r });
    return r;
  }

  async getStatus(requestId: string): Promise<PaymentRequest> {
    return this.get(requestId);
  }

  async list(billId?: string): Promise<PaymentRequest[]> {
    return [...this.requests.values()].filter((r) => !billId || r.billId === billId);
  }

  /** Demo helper: simulate the debtor paying. */
  markPaid(requestId: string): PaymentRequest {
    const r = this.get(requestId);
    r.status = "paid";
    this.tracer.log({ billId: r.billId, step: "gateway.paid", kind: "tool", args: { requestId } });
    return r;
  }

  private get(id: string): PaymentRequest {
    const r = this.requests.get(id);
    if (!r) throw new Error(`Unknown request ${id}`);
    return r;
  }
  private guard(billId: string, op: string, check: () => void) {
    try {
      check();
    } catch (e) {
      this.tracer.log({ billId, step: `gateway.${op}.refused`, kind: "error", error: (e as Error).message });
      throw e;
    }
  }
}
