// Run locally with your .env: npm run smoke:sandbox
// Creates one 1.00 sandbox invoice to SMOKE_DEBTOR_EMAIL, sends it, reads its status and cancels it.
import "dotenv/config";
import { MemoryTracer } from "../src/trace/trace.js";
import { ApprovalQueue } from "../src/approval/queue.js";
import { PayPalGateway } from "../src/gateway/PayPalGateway.js";
import { ToolkitInvoker } from "../src/gateway/toolkitInvoker.js";
import { idempotencyKey } from "../src/gateway/PaymentsGateway.js";

const { PAYPAL_CLIENT_ID = "", PAYPAL_CLIENT_SECRET = "", SMOKE_DEBTOR_EMAIL = "", CURRENCY = "EUR" } = process.env;
if (!SMOKE_DEBTOR_EMAIL) throw new Error("Set SMOKE_DEBTOR_EMAIL to a sandbox personal account email");

const tracer = new MemoryTracer();
const approvals = new ApprovalQueue(tracer);
const gw = new PayPalGateway(new ToolkitInvoker(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET), approvals, tracer);
const billId = `smoke-${Date.now()}`;

const step = (s: string, x?: unknown) => console.log(`✔ ${s}`, x ?? "");
const a = approvals.propose({ kind: "create_request", billId, debtor: "Smoke", amountCents: 100, reason: "smoke test" });
approvals.decide(a.id, true, "smoke");
const r = await gw.createRequest({
  billId, debtor: "Smoke", debtorEmail: SMOKE_DEBTOR_EMAIL, creditor: "me", amountCents: 100, currency: CURRENCY,
  memo: "Even Steven smoke test", idempotencyKey: idempotencyKey(billId, "Smoke", "me", 100), approvalId: a.id,
});
step("invoice created and sent", r.id);
step("status", (await gw.getStatus(r.id)).status);
const c = approvals.propose({ kind: "cancel_request", billId, requestId: r.id, reason: "smoke cleanup" });
approvals.decide(c.id, true, "smoke");
step("cancelled", (await gw.cancel(r.id, c.id)).status);
console.log(`\nTrace (${tracer.events.length} steps):`);
for (const e of tracer.events) console.log(` - ${e.step}${e.error ? " ERROR " + e.error : ""}`);
