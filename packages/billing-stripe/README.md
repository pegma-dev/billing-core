# `@pegma/billing-stripe`

Stripe event and snapshot translation for
[`@pegma/billing-core`](https://github.com/pegma-dev/billing-core). The
ledger stays provider-agnostic. This adapter maps Stripe event types and
subscription objects onto `LedgerEvent` / snapshot fetches.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import { createBillingLedger } from "@pegma/billing-core";
import { createStripeBillingAdapter } from "@pegma/billing-stripe";
import { createMemoryStore } from "@pegma/storage-core";

const ledger = createBillingLedger({
  store: createMemoryStore(),
  clock: { now: () => "2026-08-15T16:00:00.000Z" },
});

const stripe = createStripeBillingAdapter({
  client: {
    retrieveSubscription: (id) => hostStripe.subscriptions.retrieve(id),
  },
});

// Host verifies the webhook signature, then:
const event = stripe.translateEvent(verifiedStripeEvent);
if (event !== null) {
  await ledger.apply(accountId, event);
}

await ledger.reconcile(accountId, stripe.fetchSnapshot);
```

The host verifies Stripe signatures and binds a customer to an account
id. This package never calls `constructEvent`, never processes a
payment, and never resolves entitlements. The vendor client stays behind
`retrieveSubscription`.

Translation copies provider identifiers and derived state only — never
card data, raw payloads, line items, or amounts, even when those fields
are present on the Stripe object.

## Lifecycle mapping

| Stripe `status`      | Ledger `LifecycleStatus` |
| -------------------- | ------------------------ |
| `incomplete`         | `incomplete`             |
| `incomplete_expired` | `canceled`               |
| `trialing`           | `trialing`               |
| `active`             | `active`                 |
| `past_due`           | `past_due`               |
| `canceled`           | `canceled`               |
| `unpaid`             | `unpaid`                 |
| `paused`             | `unpaid`                 |

`incomplete_expired` is a finished first-invoice failure. `paused` is
non-granting and still live; it maps to `unpaid` so a same-second
`active` cannot resurrect it. Unknown Stripe statuses are dropped, not
coerced into a grant.

`event.id` and `event.created` become the ledger watermark
`(eventId, eventAt)`. Arrival order is not an input. A same-second
Stripe `canceled` and `active` are ranked by the core: canceled wins in
either delivery order.

Checkout Session and Invoice objects translate only when they carry an
**expanded** Subscription. A bare `sub_…` id is not enough to write
derived state — fetch the subscription through the snapshot port.

`plan` defaults to the Price `lookup_key`. Pass `planFromPrice` to map a
Price id to a host plan name. Do not put customer-specific price tables
in this package.

## What this is not

- Payment processing, Checkout UI, or Customer Portal orchestration
- Webhook signature verification (host) or receipt dedup
  ([`@pegma/webhooks`](https://github.com/pegma-dev/webhooks))
- Entitlement resolution
  ([`@pegma/authorization-stripe`](https://github.com/pegma-dev/authorization-core))
- A host `repo.js` swap (Phase 5)

Named consumers of this translation are RetireGolden.org (Stripe
subscriptions) and Exsimplify (Stripe Checkout today; the adapter still
translates subscription and event shapes for the ledger). Their private
account internals stay out of this tree.

Phase 4 is in-tree and unpublished.
