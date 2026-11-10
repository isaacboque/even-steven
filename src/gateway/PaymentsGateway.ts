import type { Cents } from "../core/money.js";

export type RequestStatus = "sent" | "paid" | "cancelled";
export type PaymentRequest = {
  id: string;
  billId: string;
  debtor: string;
  creditor: string;
  amountCents: Cents;
  currency: string;
  memo: string;
  idempotencyKey: string;
  status: RequestStatus;
  createdAt: string;
  remindersSent: number;
  lastReminderAt?: string;
  externalUrl?: string;
};

export type CreateRequestInput = {
  billId: string;
  debtor: string;
  creditor: string;
  amountCents: Cents;
  currency: string;
  memo: string;
  idempotencyKey: string;
  approvalId: string;
};

/** Every method that moves money or contacts someone needs an approved approvalId. */
export interface PaymentsGateway {
  readonly name: string;
  createRequest(input: CreateRequestInput): Promise<PaymentRequest>;
  sendReminder(requestId: string, approvalId: string): Promise<PaymentRequest>;
  cancel(requestId: string, approvalId: string): Promise<PaymentRequest>;
  getStatus(requestId: string): Promise<PaymentRequest>;
  list(billId?: string): Promise<PaymentRequest[]>;
}

export function idempotencyKey(billId: string, debtor: string, creditor: string, amountCents: Cents): string {
  return `${billId}:${debtor}->${creditor}:${amountCents}`;
}
