# Even Steven

Snap a receipt, split each item fairly, and send PayPal sandbox requests with the fewest payments needed. Nothing moves without your approval, and every decision is logged.

## Status

Scaffold only. Flows, approval queue, traces and evaluation are next.

## Setup

1. Copy `.env.example` to `.env` and add your PayPal sandbox credentials and LLM key. Never commit `.env`.
2. `npm install`
3. `npm run build && npm start`
