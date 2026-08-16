# Billing Core

[![CI](https://github.com/pegma-dev/billing-core/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/billing-core/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A provider-agnostic subscription ledger for [Pegma](https://pegma.dev)
hosts: the durable record of what a customer's subscription **is**,
maintained correctly under out-of-order webhook delivery.

> [!IMPORTANT]
> Pegma is in early `0.x` development. `@pegma/billing-core` and
> `@pegma/billing-stripe` are published at `0.1.1`. The `0.x` API is
> unstable.

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

Phase 4 ships the watermark, the effective-watermark guard,
lifecycle-rank arbitration, declared ledger invariants (`sticky`,
`firstWins`), the checkout reservation, snapshot reconciliation, and
Stripe event/snapshot translation. The core knows lifecycle states, not
Stripe's vocabulary — `@pegma/billing-stripe` is the translation. And
the data boundary is absolute: the ledger stores provider identifiers
and derived state — never a card number, a raw payload, or an amount.

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

## Packages

| Package                 | Role                                                    | Phase |
| ----------------------- | ------------------------------------------------------- | ----- |
| `@pegma/billing-core`   | Ledger, watermark, rank, invariants, reservation, sweep | 4     |
| `@pegma/billing-stripe` | Event and snapshot translation                          | 4     |

## Constraint that shapes everything

**Arrival order proves nothing.** Every apply goes through the
effective-watermark guard and lifecycle rank. Race tests over the memory
store and real Azurite are the specification.

## Documentation

- [Project plan](docs/PROJECT_PLAN.md) — phases, scope, and decisions
- [Releasing](docs/RELEASING.md) — trusted-publisher release runbook

## Development

Requires Node.js 22 or 24. Corepack is bundled through Node 24; on Node 25
or newer, install it first.

```sh
npm install -g corepack
corepack enable
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
pnpm test
```

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
