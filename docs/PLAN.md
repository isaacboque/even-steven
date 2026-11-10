# Even Steven — build plan (PayPal AI Hackathon)

Deadline: **Thu 12 Nov 2026, 12:00 PT (21:00 Madrid)**. Internal target: submitted by 20:00 Madrid.

Pitch: snap a receipt, split each item fairly, and send PayPal sandbox requests with the fewest payments needed. Nothing moves without your approval, and every decision is logged.

## Flows (only these)
1. **Receipt → line items**: a vision LLM reads the photo; the user corrects the list on screen. Items must sum to the receipt total (in cents) before continuing.
2. **Assignment**: each item goes to one or more people (shared dishes split evenly by default). Tax and tip are spread in proportion to each person's subtotal.
3. **Minimum settlement**: net balance per person, then the fewest transfers that square everyone up.
4. **PayPal requests**: one PayPal sandbox invoice per debtor (the payer is the invoicer). Created only after approval in the queue.
5. **Reminder**: invoices still unpaid after N days get a PayPal reminder (also behind approval).

## Non-negotiable rules
- **Money is integer cents** everywhere. Rounding uses largest remainder so shares always sum exactly to the total.
- **Approval gate**: every money-moving call (create/send invoice, reminder, cancel) goes through the approval queue. The gateway refuses a call without a valid approval id.
- **Idempotency**: each request has a deterministic key (bill id + debtor + amount); a second create with the same key returns the existing request, never a duplicate.
- **Traces**: every step (LLM call, tool call, args, result, decision, approval) is one JSONL line in `traces/<billId>.jsonl`, shown in the trace panel.
- **No secrets in the repo.** Only `.env.example`. Sandbox only.

## Architecture
```
src/core/      money.ts, split.ts, settle.ts (pure, fully tested)
src/trace/     JSONL trace writer + reader
src/approval/  approval queue (pending → approved/rejected), in-memory + JSON file
src/gateway/   PaymentsGateway interface; MockGateway (default, demo + tests); PayPalGateway (@paypal/agent-toolkit, sandbox)
src/receipt/   ReceiptReader interface; FixtureReader; VisionReader (Vercel AI SDK, provider from env)
src/agent/     agent loop: LLM with PayPal toolkit tools, every money tool wrapped by the approval gate
src/server/    small HTTP API (Hono) used by the web UI
web/           Vite + React + TypeScript UI: receipt screen, assignment, settlement preview, approval queue, trace panel
eval/          20 scenarios + runner; writes eval/RESULTS.md and the table in README
```
- Tests: Vitest. CI (`.github/workflows/ci.yml`): install, typecheck, test, build. PRs merge only when CI is green.
- LLM: Vercel AI SDK; provider chosen by `LLM_PROVIDER` (`google` | `openai` | `anthropic`) + `LLM_MODEL`, key from env. All tests use mocked models.
- `DEMO_MODE=mock` (default) runs the whole app with MockGateway and FixtureReader, so the demo and CI never need keys.

## Evaluation (20 scenarios, simulated clock)
Each scenario checks: shares sum to the receipt total with no cent lost; number of transfers equals the brute-force minimum (groups ≤ 8); no duplicate request after retries; nothing sent without approval; reminders only after N days and only for unpaid. Output: pass/fail table in `eval/RESULTS.md` and README.

## Work items (Claude Code via the vault queue)
| # | Item | Depends on |
|---|---|---|
| T1 | Core: money, split, settle (+ brute-force optimum check), Vitest | — |
| T2 | Trace writer, approval queue, PaymentsGateway + MockGateway | — |
| T3 | Receipt reader: interface, fixtures, VisionReader, total check | — |
| T4 | Eval harness (20 scenarios) + README table | T1, T2 |
| T5 | PayPalGateway with @paypal/agent-toolkit (invoices, reminders, status, token refresh), smoke script | T2 |
| T6 | Agent loop + HTTP API (approval-gated tools, traces) | T2, T3 |
| T7 | Web UI (Vite React) on top of the API | T6 |
| T8 | README for judges, `.env.example`, AI tools section, clean-clone check | T4–T7 |

## Human-only steps
- Isaac: PayPal sandbox app (client id/secret) and two sandbox personal accounts for the demo; LLM key with spend cap; put them in local `.env` only.
- Isaac: run `npm run smoke:sandbox` locally once T5 lands; take 5 real receipt photos for the demo.
- Isaac: record the YouTube video (<3 min, no copyrighted music), Devpost submission, invite Judit to the Devpost team.

## Timeline (Madrid)
- **Tue 10 evening**: plan + CI merged; T1, T2, T3 queued.
- **Wed 11**: T4–T7 land. Isaac: credentials, sandbox smoke test in the evening.
- **Wed 11, 22:00 — go/no-go**: a real sandbox invoice created from the app after approval. If not, demo on MockGateway + recorded sandbox smoke, or drop the entry.
- **Thu 12**: T8 + fixes until 16:00; video 16:00–18:30; submit by 20:00.
