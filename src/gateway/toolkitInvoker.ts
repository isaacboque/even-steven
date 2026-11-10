import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { parseMaybeJson, type ToolInvoker } from "./PayPalGateway.js";

const REFRESH_MS = 45 * 60 * 1000;

/**
 * Runs PayPal Agent Toolkit tools directly. The toolkit caches its OAuth token forever, but sandbox tokens
 * expire after a few hours, so the toolkit is rebuilt every 45 minutes and once more after an auth error.
 */
export class ToolkitInvoker implements ToolInvoker {
  private toolkit?: PayPalAgentToolkit;
  private builtAt = 0;
  constructor(private clientId: string, private clientSecret: string, private sandbox = true) {
    if (!clientId || !clientSecret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required");
  }
  private build() {
    this.toolkit = new PayPalAgentToolkit({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      configuration: {
        actions: { invoices: { create: true, list: true, get: true, send: true, sendReminder: true, cancel: true } },
        context: { sandbox: this.sandbox },
      },
    });
    this.builtAt = Date.now();
  }
  async call(tool: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.toolkit || Date.now() - this.builtAt > REFRESH_MS) this.build();
    try {
      return await this.run(tool, params);
    } catch (e) {
      if (!/401|token|unauthori[sz]ed/i.test((e as Error).message)) throw e;
      this.build();
      return this.run(tool, params);
    }
  }
  private async run(tool: string, params: Record<string, unknown>) {
    const t = this.toolkit!.getTools()[tool] as unknown as { execute?: (a: unknown, o: unknown) => Promise<unknown> };
    if (!t?.execute) throw new Error(`PayPal tool ${tool} is not enabled`);
    const raw = await t.execute(params, { toolCallId: `es-${Date.now()}`, messages: [] });
    const out = parseMaybeJson(raw);
    // The toolkit never throws: it returns {"error":{...}} or {"code","message","status"} as JSON text.
    if (out && typeof out === "object") {
      const o = out as { error?: { message?: string }; code?: string; message?: string; status?: number };
      if (o.error) throw new Error(`PayPal ${tool}: ${o.error.message ?? "error"}`);
      if (o.code && o.message && typeof o.status === "number" && o.status >= 400) throw new Error(`PayPal ${tool} (${o.status}): ${o.message}`);
    }
    return out;
  }
}
