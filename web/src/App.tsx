import { useCallback, useEffect, useMemo, useState } from "react";
import { useRun, type RunFn } from "./useRun";
import { api, money, toCents, type Approval, type Bill, type Config, type Person, type PaymentRequest, type Settlement, type TraceEvent } from "./api";

type Step = 0 | 1 | 2 | 3;
const STEPS = ["Receipt", "Who had what", "Settle up", "Approve & track"];
const FIXTURE_LABEL: Record<string, string> = {
  "restaurant-4": "Trattoria · 4 people",
  "bar-round": "Bar round",
  "pizza-shared": "Pizza night (tax)",
  "with-tip": "Diner (tax + tip)",
  "one-cent-off": "Café (doesn't add up)",
};

export default function App() {
  const [config, setConfig] = useState<Config>();
  const [bill, setBill] = useState<Bill>();
  const [step, setStep] = useState<Step>(0);

  useEffect(() => {
    api.config().then(setConfig).catch((e) => setError(e.message));
  }, []);

  const { busy, error, setError, run } = useRun();

  return (
    <div className="shell">
      <main>
        <header className="top">
          <div className="brand">
            <span className="logo" aria-hidden><i /><i /></span>
            <div>
              <h1>Even Steven</h1>
              <p>Snap it. Split it. Settle it. Nothing moves without your approval.</p>
            </div>
          </div>
          {config && (
            <div className="badges">
              <span className={`badge ${config.gateway === "mock" ? "" : "live"}`}>{config.gateway === "mock" ? "Demo payments" : "PayPal sandbox"}</span>
              <span className="badge">Agent: {config.agent === "llm" ? "LLM" : "rules"}</span>
            </div>
          )}
        </header>

        <nav className="stepper">
          {STEPS.map((s, i) => (
            <button key={s} className={i === step ? "on" : i < step ? "done" : ""} disabled={!bill || i > maxStep(bill)} onClick={() => setStep(i as Step)} aria-current={i === step ? "step" : undefined}>
              <b>{i < step ? "✓" : i + 1}</b> <span>{s}</span>
            </button>
          ))}
        </nav>

        {error && <div className="alert">{error}</div>}

        {step === 0 && <ReceiptStep config={config} bill={bill} busy={busy} run={run} onBill={setBill} onNext={() => setStep(1)} />}
        {step === 1 && bill && <PeopleStep bill={bill} busy={busy} run={run} onBill={setBill} onNext={() => setStep(2)} />}
        {step === 2 && bill && <SettleStep bill={bill} busy={busy} run={run} onNext={() => setStep(3)} />}
        {step === 3 && bill && config && <ApproveStep bill={bill} config={config} busy={busy} run={run} />}
        {config?.gateway === "mock" && (
          <footer className="foot">
            <button
              className="linklike"
              disabled={busy}
              onClick={() => run(() => api.reset()).then((r) => { if (r) { setBill(undefined); setStep(0); } })}
            >
              Reset demo
            </button>
          </footer>
        )}
      </main>
      <TracePanel billId={bill?.id} />
    </div>
  );
}

const TONES = ["#3346d3", "#d2416e", "#7b4bd6", "#0e7fa6", "#8b5a3c", "#4a5578"];
const toneOf = new Map<string, string>();
/** One colour per person, handed out in order of first appearance so nobody shares a colour. */
export function tone(name: string): string {
  const key = name.trim().toLowerCase();
  if (!key) return "#9aa0b4";
  if (!toneOf.has(key)) toneOf.set(key, TONES[toneOf.size % TONES.length]);
  return toneOf.get(key)!;
}
function Avatar({ name }: { name: string }) {
  return <span className="avatar" style={{ background: tone(name) }} aria-hidden>{name.trim().charAt(0).toUpperCase() || "?"}</span>;
}

function maxStep(b: Bill): number {
  if (b.mismatchCents !== 0) return 0;
  if (!b.payer) return 1;
  return 3;
}


/* ---------- 1. Receipt ---------- */
function ReceiptStep({ config, bill, busy, run, onBill, onNext }: { config?: Config; bill?: Bill; busy: boolean; run: RunFn; onBill: (b: Bill) => void; onNext: () => void }) {
  const [draft, setDraft] = useState<Bill["receipt"]>();
  useEffect(() => setDraft(bill?.receipt), [bill]);
  const mismatch = draft ? draft.totalCents - (draft.items.reduce((a, i) => a + i.totalCents, 0) + draft.taxCents + draft.tipCents) : 0;
  const cur = draft?.currency ?? "EUR";

  const setItem = (k: number, patch: Partial<Bill["receipt"]["items"][number]>) =>
    setDraft((d) => d && { ...d, items: d.items.map((it, i) => (i === k ? { ...it, ...patch } : it)) });

  return (
    <section className="card">
      <h2>Read the receipt</h2>
      <div className="row wrap">
        <label className={`upload ${config?.vision ? "" : "off"}`} title={config?.vision ? "" : "Set an LLM key to read photos"}>
          Upload a photo
          <input type="file" accept="image/*" disabled={!config?.vision || busy} onChange={(e) => e.target.files?.[0] && run(() => api.fromPhoto(e.target.files![0])).then((b) => b && onBill(b))} />
        </label>
        <span className="muted">or use a sample</span>
        {config?.fixtures.map((f) => (
          <button key={f} className="chip" disabled={busy} onClick={() => run(() => api.fromFixture(f)).then((b) => b && onBill(b))}>
            {FIXTURE_LABEL[f] ?? f}
          </button>
        ))}
      </div>
      {busy && !draft && <p className="muted" role="status">Reading the receipt… this can take up to 30 seconds.</p>}

      {draft && bill && (
        <>
          <p className="muted hint">Check every line against the paper. Tap any name or amount to fix it.</p>
          <div className="slip">
          <div className="slip-head">{bill.merchant || "Receipt"}</div>
          <table className="items">
            <thead><tr><th>Item</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {draft.items.map((it, k) => (
                <tr key={it.id}>
                  <td><input value={it.name} onChange={(e) => setItem(k, { name: e.target.value })} /></td>
                  <td className="num"><MoneyInput cents={it.totalCents} onChange={(c) => setItem(k, { totalCents: c })} /></td>
                </tr>
              ))}
              <tr className="sub"><td>Tax added</td><td className="num"><MoneyInput cents={draft.taxCents} onChange={(c) => setDraft({ ...draft, taxCents: c })} /></td></tr>
              <tr className="sub"><td>Tip / service</td><td className="num"><MoneyInput cents={draft.tipCents} onChange={(c) => setDraft({ ...draft, tipCents: c })} /></td></tr>
              <tr className="total"><td>Total on receipt</td><td className="num"><MoneyInput cents={draft.totalCents} onChange={(c) => setDraft({ ...draft, totalCents: c })} /></td></tr>
            </tbody>
          </table>
          <button className="ghost addline" onClick={() => setDraft({ ...draft, items: [...draft.items, { id: `i${Date.now()}`, name: "New item", totalCents: 0 }] })}>+ Add line</button>
          </div>
          {mismatch !== 0 ? (
            <div className="alert warn">The lines add up to {money(draft.totalCents - mismatch, cur)} but the receipt says {money(draft.totalCents, cur)} (off by {money(Math.abs(mismatch), cur)}, {Math.abs(mismatch)} cent{Math.abs(mismatch) === 1 ? "" : "s"}). Fix a line before continuing — Even Steven never guesses money.</div>
          ) : (
            <div className="ok">✓ Lines, tax and tip add up to the total exactly.</div>
          )}
          <div className="actions">
            <button className="primary" disabled={busy || mismatch !== 0} onClick={() => run(() => api.saveItems(bill.id, draft)).then((b) => { if (b) { onBill(b); onNext(); } })}>
              {busy ? "Saving…" : "Continue"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function MoneyInput({ cents, onChange }: { cents: number; onChange: (c: number) => void }) {
  const [text, setText] = useState((cents / 100).toFixed(2));
  useEffect(() => setText((cents / 100).toFixed(2)), [cents]);
  return (
    <input className="money" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => {
      const c = toCents(text);
      if (Number.isNaN(c)) setText((cents / 100).toFixed(2));
      else onChange(c);
    }} />
  );
}

/* ---------- 2. People ---------- */
function PeopleStep({ bill, busy, run, onBill, onNext }: { bill: Bill; busy: boolean; run: RunFn; onBill: (b: Bill) => void; onNext: () => void }) {
  const [people, setPeople] = useState<Person[]>(bill.people.length ? bill.people : [{ name: "Me" }, { name: "" }]);
  const [payer, setPayer] = useState(bill.payer ?? "Me");
  const [asg, setAsg] = useState<Record<string, string[]>>(bill.assignment);
  const names = people.map((p) => p.name.trim()).filter(Boolean);
  const cur = bill.receipt.currency;

  const toggle = (item: string, name: string) =>
    setAsg((a) => {
      const cur = a[item] ?? [];
      return { ...a, [item]: cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name] };
    });
  const everyone = (item: string) => setAsg((a) => ({ ...a, [item]: [...names] }));

  const preview = useMemo(() => {
    const t: Record<string, number> = {};
    for (const it of bill.receipt.items) {
      const who = (asg[it.id] ?? []).filter((n) => names.includes(n));
      who.forEach((n) => (t[n] = (t[n] ?? 0) + it.totalCents / who.length));
    }
    return t;
  }, [asg, names, bill]);
  const unassigned = bill.receipt.items.filter((it) => !(asg[it.id] ?? []).some((n) => names.includes(n)));

  return (
    <section className="card">
      <h2>Who was there, and who had what</h2>
      <div className="people">
        {people.map((p, k) => (
          <div className="person" key={k}>
            <Avatar name={p.name} />
            <input placeholder="Name" value={p.name} onChange={(e) => setPeople(people.map((x, i) => (i === k ? { ...x, name: e.target.value } : x)))} />
            <input placeholder="PayPal email (sandbox)" value={p.email ?? ""} onChange={(e) => setPeople(people.map((x, i) => (i === k ? { ...x, email: e.target.value } : x)))} />
            <label className={`payer ${payer === p.name && p.name ? "on" : ""}`}><input type="radio" checked={payer === p.name} onChange={() => setPayer(p.name)} /> paid the bill</label>
          </div>
        ))}
        <button className="ghost" onClick={() => setPeople([...people, { name: "" }])}>+ Add person</button>
      </div>

      <table className="items assign">
        <tbody>
          {bill.receipt.items.map((it) => (
            <tr key={it.id}>
              <td>{it.name}<div className="muted">{money(it.totalCents, cur)}</div></td>
              <td>
                <div className="chips">
                  {names.map((n) => (
                    <button key={n} className={`chip ${(asg[it.id] ?? []).includes(n) ? "sel" : ""}`} style={{ ["--tone" as string]: tone(n) }} aria-pressed={(asg[it.id] ?? []).includes(n)} onClick={() => toggle(it.id, n)}>{n}</button>
                  ))}
                  <button className="chip ghost" onClick={() => everyone(it.id)}>everyone</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="totals">
        {names.map((n) => <span key={n} className="tot"><Avatar name={n} /> <b>{n}</b> {money(Math.round(preview[n] ?? 0), cur)}</span>)}
        <span className="muted">before tax/tip</span>
      </div>
      {unassigned.length > 0 && <div className="alert warn">Still unassigned: {unassigned.map((i) => i.name).join(", ")}</div>}
      <div className="actions">
        <button className="primary" disabled={busy || unassigned.length > 0 || !names.includes(payer)}
          onClick={() => run(() => api.saveAssignment(bill.id, {
            people: people.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), email: p.email?.trim() || undefined })),
            payer,
            assignment: Object.fromEntries(Object.entries(asg).map(([k, v]) => [k, v.filter((n) => names.includes(n))])),
          })).then((b) => { if (b) { onBill(b); onNext(); } })}>
          Settle up
        </button>
      </div>
    </section>
  );
}

/* ---------- 3. Settle ---------- */
function SettleStep({ bill, busy, run, onNext }: { bill: Bill; busy: boolean; run: RunFn; onNext: () => void }) {
  const [s, setS] = useState<Settlement>();
  const [summary, setSummary] = useState<string>();
  useEffect(() => { run(() => api.settlement(bill.id)).then((x) => x && setS(x)); }, [bill.id, run]);
  const cur = bill.receipt.currency;
  if (!s) return <section className="card"><p className="muted">Calculating…</p></section>;
  return (
    <section className="card">
      <h2>Fewest payments to square up</h2>
      <div className="shares">
        {Object.entries(s.owed).map(([p, c]) => (
          <div key={p} className={`share ${p === s.payer ? "payer-share" : ""}`}><span className="who"><Avatar name={p} /> {p}</span><b>{money(c, cur)}</b><small>{p === s.payer ? "own share · paid the bill" : "share incl. tax & tip"}</small></div>
        ))}
      </div>
      <h3>{s.transfers.length} payment{s.transfers.length === 1 ? "" : "s"} <span className="badge good">minimum possible</span></h3>
      <ul className="transfers">
        {s.transfers.map((t) => (
          <li key={t.from}><Avatar name={t.from} /> <b>{t.from}</b> <span className="arrow">pays</span> <Avatar name={t.to} /> <b>{t.to}</b> <span className="amt">{money(t.amountCents, cur)}</span></li>
        ))}
      </ul>
      {summary && <div className="ok">{summary}</div>}
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => run(() => api.propose(bill.id)).then((r) => { if (r) { setSummary(r.summary); onNext(); } })}>
          {busy ? "Asking the agent…" : "Ask the agent to prepare PayPal requests"}
        </button>
      </div>
      <p className="muted small">The agent can only propose. Each request waits for your approval in the next step.</p>
    </section>
  );
}

/* ---------- 4. Approve & track ---------- */
export function ApproveStep({ bill, config, busy, run }: { bill: Bill; config: Config; busy: boolean; run: RunFn }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const cur = bill.receipt.currency;
  const refresh = useCallback(async () => {
    const [a, r] = await Promise.all([api.approvals(bill.id), api.requests(bill.id)]);
    setApprovals(a);
    setRequests(r);
  }, [bill.id]);
  useEffect(() => { refresh(); }, [refresh]);
  const [working, setWorking] = useState<string>();
  const act = (key: string, fn: () => Promise<unknown>) => {
    setWorking(key);
    return run(fn).then(refresh).finally(() => setWorking(undefined));
  };
  const pending = approvals.filter((a) => a.status === "pending");
  const done = approvals.filter((a) => a.status !== "pending");

  return (
    <section className="card">
      <h2>Approve, then track</h2>
      <h3>Waiting for you ({pending.length})</h3>
      {pending.length === 0 && <p className="muted empty">Nothing waiting for approval. Ask the agent again after a few days to check for unpaid requests.</p>}
      {pending.map((a) => (
        <div key={a.id} className="approval">
          <div>
            <div className="kind">{a.action.kind === "create_request" ? "PayPal request" : a.action.kind === "send_reminder" ? "Reminder" : "Cancel"}</div>
            <div className="who-line"><Avatar name={a.action.debtor ?? ""} /> <b>{a.action.debtor}</b> {a.action.amountCents != null && <span className="amt">{money(a.action.amountCents, cur)}</span>}</div>
            <div className="muted">{a.action.reason}</div>
          </div>
          <div className="row">
            <button className="ghost" disabled={busy} onClick={() => act(`reject:${a.id}`, () => api.reject(a.id, "rejected in UI"))}>{working === `reject:${a.id}` ? "Rejecting…" : "Reject"}</button>
            <button className="primary" disabled={busy} onClick={() => act(`approve:${a.id}`, () => api.approve(a.id))}>{working === `approve:${a.id}` ? "Sending…" : "Approve & send"}</button>
          </div>
        </div>
      ))}

      <h3>PayPal requests</h3>
      <table className="items">
        <thead><tr><th>Who</th><th className="num">Amount</th><th>Status</th><th>Reminders</th><th /></tr></thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td><div className="who-line"><Avatar name={r.debtor} /> {r.debtor}</div><div className="muted small mono">{r.id}</div></td>
              <td className="num">{money(r.amountCents, cur)}</td>
              <td><span className={`status ${r.status}`}>{r.status}</span></td>
              <td>{r.remindersSent}</td>
              <td>
                {r.externalUrl && <a href={r.externalUrl} target="_blank" rel="noreferrer">open</a>}
                {config.gateway === "mock" && r.status === "sent" && <button className="chip" disabled={busy} onClick={() => act(`paid:${r.id}`, () => api.markPaid(r.id))}>simulate paid</button>}
              </td>
            </tr>
          ))}
          {requests.length === 0 && <tr><td colSpan={5} className="muted">No requests sent yet.</td></tr>}
        </tbody>
      </table>

      <div className="actions row">
        {config.gateway === "mock" && <button className="ghost" disabled={busy} onClick={() => act("advance", () => api.advance(config.reminderAfterDays + 1))}>Skip {config.reminderAfterDays + 1} days</button>}
        <button className="ghost" disabled={busy} onClick={() => act("propose", () => api.propose(bill.id))}>{working === "propose" ? "Asking the agent…" : "Ask the agent to check for unpaid"}</button>
      </div>

      {done.length > 0 && (
        <details>
          <summary>History ({done.length})</summary>
          <ul className="history">
            {done.map((a) => <li key={a.id}><span className={`status ${a.status}`}>{a.status}</span> {a.action.kind.replace("_", " ")} · {a.action.debtor} {a.action.amountCents != null && money(a.action.amountCents, cur)}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}

/* ---------- Trace panel ---------- */
function TracePanel({ billId }: { billId?: string }) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [open, setOpen] = useState<number>();
  useEffect(() => {
    if (!billId) return;
    let alive = true;
    const tick = () => api.trace(billId).then((e) => alive && setEvents(e)).catch(() => {});
    tick();
    const t = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [billId]);
  const shown = events.filter((e) => filter === "all" || e.kind === filter);
  return (
    <aside className="trace">
      <h2>Trace</h2>
      <p className="muted small">Every decision, tool call and approval, as it happens (JSONL).</p>
      <div className="chips">
        {["all", "llm", "tool", "decision", "approval", "error"].map((k) => (
          <button key={k} className={`chip ${filter === k ? "sel" : ""}`} onClick={() => setFilter(k)}>{k}</button>
        ))}
      </div>
      <ol>
        {shown.slice().reverse().map((e, i) => (
          <li key={`${e.ts}-${i}`} className={`ev ${e.kind}`} onClick={() => setOpen(open === i ? undefined : i)}>
            <div className="evh"><span className="kindtag">{e.kind}</span> <b>{e.step}</b> <time>{new Date(e.ts).toLocaleTimeString()}</time></div>
            {e.error && <div className="everr">{e.error}</div>}
            {open === i && <pre>{JSON.stringify({ args: e.args, result: e.result }, null, 2)}</pre>}
          </li>
        ))}
        {!billId && <li className="muted">Start with a receipt.</li>}
      </ol>
    </aside>
  );
}
