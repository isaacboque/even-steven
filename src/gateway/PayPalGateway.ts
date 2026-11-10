import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApprovalQueue } from "../approval/queue.js";
import type { Tracer } from "../trace/trace.js";
import type { CreateRequestInput, PaymentRequest, PaymentsGateway, RequestStatus } from "./PaymentsGateway.js";

/** Calls one PayPal Agent Toolkit tool by name. Injected so tests never touch the network. */
export interface ToolInvoker {
  call(tool: string, params: Record<string, unknown>): Promise<unknown>;
}

type Stored = Omit<PaymentRequest, "status"> & { status: RequestStatus };

/**
 * PaymentsGateway on the PayPal sandbox via the PayPal Agent Toolkit invoicing tools.
 * One invoice per debtor, sent by the merchant account behind PAYPAL_CLIENT_ID (the person who paid the bill).
 * Same approval and idempotency rules as MockGateway; idempotency keys are stored in data/paypal-requests.json
 * and also written to the invoice "reference" field.
 */
export class PayPalGateway implements PaymentsGateway {
  readonly name = "paypal-sandbox";
  private requests = new Map<string, Stored>();

  constructor(
    private tools: ToolInvoker,
    private approvals: ApprovalQueue,
    private tracer: Tracer,
    private opts: { file?: string; now?: () => Date } = {},
  ) {
    if (opts.file && existsSync(opts.file)) {
      for (const r of JSON.parse(readFileSync(opts.file, "utf8")) as Stored[]) this.requests.set(r.id, r);
    }
  }

  async createRequest(input: CreateRequestInput): Promise<PaymentRequest> {
    const dup = [...this.requests.values()].find((r) => r.idempotencyKey === input.idempotencyKey);
    if (dup) {
      this.tracer.log({ billId: input.billId, step: "gateway.create.duplicate", kind: "tool", args: input, result: { id: dup.id } });
      return dup;
    }
    this.guard(input.billId, "create", () => this.approvals.assertExecutable(input.approvalId, "create_request"));
    if (!input.debtorEmail) throw new Error(`No PayPal email for ${input.debtor}`);

    const params = {
      currency_code: input.currency,
      reference: input.idempotencyKey.slice(0, 120),
      note: input.memo,
      primary_recipients: [{ billing_info: { email_address: input.debtorEmail, name: { given_name: input.debtor } } }],
      items: [
        {
          name: `Even Steven: ${input.memo}`.slice(0, 200),
          quantity: "1",
          unit_amount: { currency_code: input.currency, value: (input.amountCents / 100).toFixed(2) },
        },
      ],
    };
    const created = await this.call(input.billId, "create_invoice", params);
    const id = extractInvoiceId(created);
    await this.call(input.billId, "send_invoice", { invoice_id: id, send_to_recipient: true });

    const r: Stored = {
      id,
      billId: input.billId,
      debtor: input.debtor,
      creditor: input.creditor,
      amountCents: input.amountCents,
      currency: input.currency,
      memo: input.memo,
      idempotencyKey: input.idempotencyKey,
      status: "sent",
      createdAt: this.now(),
      remindersSent: 0,
      externalUrl: `https://www.sandbox.paypal.com/invoice/p/#${id}`,
    };
    this.requests.set(id, r);
    this.persist();
    this.approvals.markExecuted(input.approvalId, { requestId: id });
    return r;
  }

  async sendReminder(requestId: string, approvalId: string): Promise<PaymentRequest> {
    const r = await this.getStatus(requestId);
    this.guard(r.billId, "remind", () => this.approvals.assertExecutable(approvalId, "send_reminder"));
    if (r.status !== "sent") throw new Error(`Cannot remind: request ${requestId} is ${r.status}`);
    await this.call(r.billId, "send_invoice_reminder", { invoice_id: requestId, note: "Friendly reminder from Even Steven" });
    r.remindersSent++;
    r.lastReminderAt = this.now();
    this.persist();
    this.approvals.markExecuted(approvalId, { requestId });
    return r;
  }

  async cancel(requestId: string, approvalId: string): Promise<PaymentRequest> {
    const r = this.get(requestId);
    this.guard(r.billId, "cancel", () => this.approvals.assertExecutable(approvalId, "cancel_request"));
    await this.call(r.billId, "cancel_sent_invoice", { invoice_id: requestId, send_to_recipient: false });
    r.status = "cancelled";
    this.persist();
    this.approvals.markExecuted(approvalId, { requestId });
    return r;
  }

  async getStatus(requestId: string): Promise<PaymentRequest> {
    const r = this.get(requestId);
    const inv = (await this.call(r.billId, "get_invoice", { invoice_id: requestId })) as { status?: string };
    r.status = mapStatus(inv?.status, r.status);
    this.persist();
    return r;
  }

  async list(billId?: string): Promise<PaymentRequest[]> {
    return [...this.requests.values()].filter((r) => !billId || r.billId === billId);
  }

  private async call(billId: string, tool: string, params: Record<string, unknown>): Promise<unknown> {
    const started = Date.now();
    try {
      const result = parseMaybeJson(await this.tools.call(tool, params));
      this.tracer.log({ billId, step: `paypal.${tool}`, kind: "tool", args: params, result: { result, ms: Date.now() - started } });
      return result;
    } catch (e) {
      this.tracer.log({ billId, step: `paypal.${tool}`, kind: "error", args: params, error: (e as Error).message });
      throw e;
    }
  }
  private get(id: string): Stored {
    const r = this.requests.get(id);
    if (!r) throw new Error(`Unknown request ${id}`);
    return r;
  }
  private now() {
    return (this.opts.now ?? (() => new Date()))().toISOString();
  }
  private persist() {
    if (!this.opts.file) return;
    mkdirSync(dirname(this.opts.file), { recursive: true });
    writeFileSync(this.opts.file, JSON.stringify([...this.requests.values()], null, 2));
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

export function parseMaybeJson(x: unknown): unknown {
  if (typeof x !== "string") return x;
  try {
    return JSON.parse(x);
  } catch {
    return x;
  }
}

/** create_invoice returns either the invoice ({ id }) or a link ({ href: ".../invoices/INV2-XXXX" }). */
export function extractInvoiceId(x: unknown): string {
  const o = parseMaybeJson(x) as Record<string, unknown> | string;
  if (typeof o === "string") {
    const m = o.match(/INV2(-[A-Z0-9]{4}){4}/);
    if (m) return m[0];
  } else if (o && typeof o === "object") {
    if (typeof o.id === "string") return o.id;
    if (typeof o.href === "string") return o.href.split("/").pop()!;
    const links = o.links as { href: string; rel: string }[] | undefined;
    const self = links?.find((l) => l.rel === "self") ?? links?.[0];
    if (self) return self.href.split("/").pop()!;
  }
  throw new Error(`Could not find the invoice id in the PayPal response: ${JSON.stringify(o).slice(0, 300)}`);
}

export function mapStatus(paypal: string | undefined, fallback: RequestStatus): RequestStatus {
  switch (paypal) {
    case "PAID":
    case "MARKED_AS_PAID":
      return "paid";
    case "CANCELLED":
      return "cancelled";
    case "SENT":
    case "UNPAID":
    case "PARTIALLY_PAID":
    case "SCHEDULED":
      return "sent";
    default:
      return fallback;
  }
}
