# AGENTS.md — Even Steven

Read `docs/PLAN.md` first: it holds the scope, the rules and the work items (T1–T8).

- Stack: Node 20, TypeScript (strict, ESM), Vitest, Vercel AI SDK, `@paypal/agent-toolkit`, Hono, Vite + React for `web/`.
- Checks before every PR: `npm run typecheck && npm test && npm run build` (same as CI).
- Money is integer cents. Every money-moving call goes through the approval queue. Every step is traced to JSONL.
- Never commit `.env`, keys, real receipts with personal data, or anything outside sandbox. Tests use mocks only.
- One PR per work item, branch named after the item. Out-of-scope ideas go in the PR description, not in code.
- If a product decision comes up, take the smallest reasonable choice and write it in the PR description under "Decisions".
