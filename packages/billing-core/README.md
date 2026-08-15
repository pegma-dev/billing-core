# `@pegma/billing-core`

Provider-agnostic subscription ledger for Pegma hosts: a per-account
watermark, an effective-watermark guard, and lifecycle-rank tie-breaking
at the equal second.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import { createBillingLedger } from "@pegma/billing-core";
import { createMemoryStore } from "@pegma/storage-core";

const ledger = createBillingLedger({
  store: createMemoryStore(),
});

const result = await ledger.apply("acct_123", {
  eventId: "evt_canceled",
  eventAt: "2026-08-15T16:00:00.000Z",
  status: "canceled",
  providerCustomerId: "cus_123",
  providerSubscriptionId: "sub_123",
  providerPriceId: "price_pro",
  plan: "pro",
  periodStartAt: "2026-08-01T00:00:00.000Z",
  periodEndAt: "2026-09-01T00:00:00.000Z",
  trialStartAt: null,
  trialEndAt: null,
  cancelAtPeriodEnd: false,
});
```

Hosts inject a `@pegma/storage-core` `Store` and, optionally, a Spine
`Clock` and `Logger`. This package never creates a network client and never
stores card data, raw payloads, line items, or amounts.

Arrival order proves nothing. Every apply goes through the effective-watermark
guard and lifecycle rank. Exact redelivery is an idempotent no-op.

Phase 1 is the arbitration core. Invariant combinators, checkout reservation,
snapshot reconciliation, and the Stripe adapter are later phases — do not
import them from this package.
