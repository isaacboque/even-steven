import { BillStore } from "../bills/store.js";
import { ApprovalQueue } from "../approval/queue.js";
import { JsonlTracer } from "../trace/trace.js";
import { MockGateway } from "../gateway/MockGateway.js";
import { PayPalGateway } from "../gateway/PayPalGateway.js";
import { ToolkitInvoker } from "../gateway/toolkitInvoker.js";
import { FixtureReader } from "../receipt/FixtureReader.js";
import { VisionReader } from "../receipt/VisionReader.js";
import { modelFromEnv } from "../llm/model.js";
import type { AppDeps } from "./app.js";

const hasLlmKey = (e: NodeJS.ProcessEnv) => Boolean(e.GOOGLE_GENERATIVE_AI_API_KEY || e.OPENAI_API_KEY || e.ANTHROPIC_API_KEY);

/** DEMO_MODE=mock (default): MockGateway, simulated clock. DEMO_MODE=paypal: real PayPal sandbox. LLM used when a key is set. */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): AppDeps {
  const mode = env.DEMO_MODE === "paypal" ? "paypal" : "mock";
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);
  const tracer = new JsonlTracer("traces", now);
  const approvals = new ApprovalQueue(tracer, { file: `data/${mode}/approvals.json`, now });
  const gateway =
    mode === "paypal"
      ? new PayPalGateway(new ToolkitInvoker(env.PAYPAL_CLIENT_ID ?? "", env.PAYPAL_CLIENT_SECRET ?? ""), approvals, tracer, { file: "data/paypal/requests.json", now })
      : new MockGateway(approvals, tracer, now);
  const model = hasLlmKey(env) ? modelFromEnv(env) : undefined;
  return {
    bills: new BillStore(`data/${mode}/bills.json`),
    approvals,
    gateway,
    tracer,
    fixtures: new FixtureReader(),
    vision: model ? (billId: string) => new VisionReader(model, tracer, billId) : undefined,
    model,
    clock: { now, advanceDays: mode === "mock" ? (d: number) => (offsetMs += d * 86400000) : undefined },
  };
}
