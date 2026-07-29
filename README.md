# Billing Core

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A provider-agnostic subscription ledger for [Pegma](https://pegma.dev)
hosts: the durable record of what a customer's subscription **is**,
maintained correctly under out-of-order webhook delivery.

> [!IMPORTANT]
> Billing Core is in planning. Nothing is built or published; extraction
> from the production reference implementation is scheduled deliberately.
> See [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md).

## The part everyone gets wrong

Billing providers deliver webhooks at-least-once and out of order. A
ledger that applies them in arrival order will eventually let a stale
`active` resurrect a subscription a same-second `canceled` already ended —
silently, surfacing as a support ticket or a revenue leak, never as an
error. The heart of this component is the event-arbitration guard that
makes that impossible:

- a per-account **watermark** of the last applied event (exact redelivery
  → idempotent no-op);
- a **snapshot freshness bound**, advanced even by no-op reconciliation
  sweeps, so a delayed intermediate webhook cannot land after one;
- **lifecycle-rank tie-breaking** at the equal second — never delivery
  order — so terminal states outrank granting ones;
- periodic **snapshot reconciliation** that repairs field drift without
  disturbing the dedup identity of the events themselves.

Around that core: **declared ledger invariants** enforced inside the write
path (`sticky` flags that only flip one way; `firstWins` consent capture
that concurrent deliveries cannot violate) and an **atomic
single-opportunity checkout reservation** for one-per-customer offers.

Ships with a Stripe adapter; the core knows lifecycle states, not Stripe's
vocabulary. And the data boundary is absolute: the ledger stores provider
identifiers and derived state — never a card number, a raw payload, or an
amount.

Not here, on purpose: payment processing and checkout flows, entitlement
resolution ([Authorization Core](https://github.com/pegma-dev/authorization-core)'s
job), receipt dedup ([`@pegma/webhooks`](https://github.com/pegma-dev/webhooks)),
invoicing, tax, metering, and dunning orchestration.

## Where it fits

Between two components that deliberately refuse this job: webhooks dedupes
deliveries but excludes ordering; the authorization adapters collapse
ledger state into entitlements but own no lifecycle semantics. The
pipeline: provider webhook → receipt dedup → **billing-core** →
entitlements. Extracted from the RetireGolden account API's
production-tested subscription ledger, the ecosystem's reference
application.

## License

MIT © RetireGolden, LLC
