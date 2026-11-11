export type Item = { id: string; name: string; totalCents: number };
export type Person = { name: string; email?: string };
export type Bill = {
  id: string; merchant: string; mismatchCents: number; people: Person[]; payer?: string; assignment: Record<string, string[]>;
  receipt: { currency: string; items: Item[]; taxCents: number; tipCents: number; totalCents: number };
};
export type Transfer = { from: string; to: string; amountCents: number };
export type Settlement = { transfers: Transfer[]; owed: Record<string, number>; subtotals: Record<string, number>; payer: string; method: string; greedyWasSuboptimal: boolean };
export type Approval = {
  id: string; status: "pending" | "approved" | "rejected" | "executed"; createdAt: string; decisionNote?: string; result?: { requestId?: string };
  action: { kind: string; billId: string; debtor?: string; creditor?: string; amountCents?: number; requestId?: string; reason: string };
};
export type PaymentRequest = { id: string; debtor: string; amountCents: number; status: string; remindersSent: number; createdAt: string; externalUrl?: string };
export type TraceEvent = { ts: string; step: string; kind: string; args?: unknown; result?: unknown; error?: string };
export type Config = { gateway: string; agent: string; vision: boolean; fixtures: string[]; reminderAfterDays: number; now: string; resettable?: boolean };
export type AgentRun = { proposals: Approval[]; summary: string; mode: string; refused: string[] };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: init?.json !== undefined ? { "content-type": "application/json" } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

export const api = {
  config: () => req<Config>("/api/config"),
  fromFixture: (fixtureId: string) => req<Bill>("/api/bills", { method: "POST", json: { fixtureId } }),
  fromPhoto: async (file: File) => {
    const fd = new FormData();
    fd.append("image", await shrink(file));
    return req<Bill>("/api/bills", { method: "POST", body: fd });
  },
  saveItems: (id: string, r: Bill["receipt"]) => req<Bill>(`/api/bills/${id}/items`, { method: "PUT", json: r }),
  saveAssignment: (id: string, body: { people: Person[]; payer: string; assignment: Record<string, string[]> }) =>
    req<Bill>(`/api/bills/${id}/assignment`, { method: "PUT", json: body }),
  settlement: (id: string) => req<Settlement>(`/api/bills/${id}/settlement`),
  propose: (id: string) => req<AgentRun>(`/api/bills/${id}/propose`, { method: "POST", json: {} }),
  approvals: (billId: string) => req<Approval[]>(`/api/approvals?billId=${billId}`),
  approve: (id: string) => req<unknown>(`/api/approvals/${id}/approve`, { method: "POST", json: {} }),
  reject: (id: string, note?: string) => req<unknown>(`/api/approvals/${id}/reject`, { method: "POST", json: { note } }),
  requests: (id: string) => req<PaymentRequest[]>(`/api/bills/${id}/requests`),
  trace: (id: string) => req<TraceEvent[]>(`/api/bills/${id}/trace`),
  advance: (days: number) => req<{ now: string }>("/api/dev/advance", { method: "POST", json: { days } }),
  reset: () => req<{ ok: boolean }>("/api/dev/reset", { method: "POST", json: {} }),
  markPaid: (requestId: string) => req<unknown>(`/api/dev/paid/${requestId}`, { method: "POST", json: {} }),
};

export const money = (cents: number, currency = "EUR") =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(cents / 100);
export const toCents = (s: string) => {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

/** Phone photos are 3–10 MB: resize to max 1600 px JPEG before upload (faster and cheaper to read). Falls back to the original if the browser can't decode it (e.g. HEIC on Windows). */
export async function shrink(file: File, max = 1600): Promise<File> {
  try {
    if (typeof createImageBitmap !== "function" || file.size < 600_000) return file;
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return blob ? new File([blob], "receipt.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}
