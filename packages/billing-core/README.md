# `@pegma/billing-core`

Provider-agnostic subscription ledger for Pegma hosts: a per-account
watermark, an effective-watermark guard, lifecycle-rank tie-breaking at
the equal second, declared write-path invariants, a single-opportunity
checkout reservation, and snapshot reconciliation.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import { createBillingLedger, firstWins, sticky } from "@pegma/billing-core";
import { createMemoryStore } from "@pegma/storage-core";
import { fixedClock } from "@pegma/spine";

const ledger = createBillingLedger({
  store: createMemoryStore(),
  clock: fixedClock("2026-08-15T16:00:00.000Z"),
  fields: {
    foundingMember: sticky(),
    consentAt: firstWins("consent"),
    consentVersion: firstWins("consent"),
  },
});

await ledger.apply("acct_123", {
  eventId: "evt_founding",
  eventAt: "2026-08-15T16:00:00.000Z",
  status: "active",
  providerCustomerId: "cus_123",
  providerSubscriptionId: "sub_123",
  providerPriceId: "price_founding",
  plan: "founding",
  periodStartAt: "2026-08-01T00:00:00.000Z",
  periodEndAt: "2026-09-01T00:00:00.000Z",
  trialStartAt: null,
  trialEndAt: null,
  cancelAtPeriodEnd: false,
  fields: {
    foundingMember: true,
    consentAt: "2026-08-15T16:00:00.000Z",
    consentVersion: "v1",
  },
});

const reserved = await ledger.reserve("acct_456");
if (reserved.reserved) {
  await ledger.release("acct_456", reserved.reservationId);
}

await ledger.reconcile("acct_123", async (observed) => ({
  status: observed.status,
  providerCustomerId: observed.providerCustomerId,
  providerSubscriptionId: observed.providerSubscriptionId,
  providerPriceId: observed.providerPriceId,
  plan: observed.plan,
  periodStartAt: observed.periodStartAt,
  periodEndAt: observed.periodEndAt,
  trialStartAt: observed.trialStartAt,
  trialEndAt: observed.trialEndAt,
  cancelAtPeriodEnd: observed.cancelAtPeriodEnd,
}));
```

Hosts inject a `@pegma/storage-core` `Store` and, optionally, a Spine
`Clock` and `Logger`. Reservation TTL and snapshot freshness (`snapshotAt`)
are taken from the injected clock — never from `Date.now()`. This package
never creates a network client and never stores card data, raw payloads,
line items, or amounts.

Arrival order proves nothing. Every apply goes through the effective-watermark
guard and lifecycle rank. Exact redelivery is an idempotent no-op.

`sticky` and `firstWins` are declared on the host's ledger definition and
enforced inside the update decider, so they re-evaluate against fresh state
on every conflict. A reservation id is minted inside the decider and read
back from storage; the caller's id is whatever the stored record says.

Snapshot reconciliation observes the domain CAS token `(eventAt, eventId)`
and the current `snapshotAt`, samples the freshness bound from the injected
clock, then fetches provider truth. The decider re-checks both the watermark
and the observed `snapshotAt` against fresh state. An intervening event or a
newer reconciliation drops the snapshot. A reservation-only row is skipped
so a founding webhook is not gated by an invented bound. A token match
always writes — even when no field changed — so `snapshotAt` advances and a
delayed intermediate webhook cannot land after a no-op sweep. The watermark
identity is never touched.

Phase 3 is the arbitration core, combinators, reservation, and snapshot
reconciliation. The Stripe adapter is a later phase — do not import it
from this package.
