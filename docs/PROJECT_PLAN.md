# Billing Core Project Plan

## Status

**Stage:** Phase 2 — combinators and reservation in-tree. Nothing is
published. (`0.1.0`, unpublished.)

**Extraction source:** the RetireGolden account API's subscription ledger —
`api/src/lib/repo.js` (`shouldApplyEvent`, `applySubscriptionSnapshot`,
`enforceLedgerInvariants`, the founding-checkout reservation) and
`api/src/lib/reconcile.js` — hardened by real Stripe traffic and a test
suite that covers the concurrency corners. By the storage plan's own
assessment it is the subtlest code in that codebase, which is exactly why
it should be written once, here, and never re-derived.

**License:** MIT

**Storage:** collections over an injected `@pegma/storage-core` `Store`;
time and logging from `@pegma/spine`. Pinned exactly.

## Vision

Every subscription SaaS keeps a durable record of what each customer's
subscription _is_, and nearly all of them maintain it wrong in the same
quiet way: billing providers deliver webhooks at-least-once and out of
order, and a ledger that applies events in arrival order will eventually
let a stale `active` resurrect a subscription that a same-second
`canceled` already ended. The failure is silent — a customer's access
state diverging from what they pay for — and it surfaces as a support
ticket or a revenue leak, never as an error.

One subscription ledger, provider-agnostic, whose event arbitration,
drift repair, and write-path invariants are the component — so a host
wires an adapter and gets the part everyone gets wrong, already right.

## Where it sits in the stack

Between two components that deliberately refuse this job:
[`@pegma/webhooks`](https://github.com/pegma-dev/webhooks) dedupes
_receipts_ and explicitly excludes ordering ("domain logic"); Authorization
Core's Stripe adapter collapses ledger state into active-or-absent
_entitlements_ and explicitly has no expiry or lifecycle semantics. The
ordering and invariant semantics in the middle are owned by nobody — this
component is that middle. A typical host pipeline:
provider webhook → webhooks receipt (dedup) → **billing-core (arbitrate,
apply, repair)** → authorization adapter (entitle).

## Fundamental model

**Ledger record** — one per billing account, keyed by a host-chosen
account id: provider customer/subscription/price identifiers, lifecycle
status, tier/plan reference, period and trial instants, cancel-at-period-
end, plus host-declared fields governed by invariant combinators (below).
One subscription per account in v1 (see Open questions).

**Event watermark** — the `(eventAt, eventId)` pair of the last applied
provider event. The id makes an exact redelivery idempotent; the timestamp
orders distinct events; together they are also the reconciliation sweep's
cross-request CAS token — a DOMAIN token carried in fields, deliberately
not a storage version, because it must survive across requests and
processes.

**Effective watermark and lifecycle rank** — an event applies only if
strictly newer than `max(eventAt, snapshotAt)`. A distinct event sharing
that exact second is resolved by lifecycle RANK, never delivery order:
terminal non-granting states outrank granting ones, so a stale `active`
cannot restore a same-second `canceled`, while a transient `incomplete`
still loses to a same-second `active`. Equal rank at the equal second
drops the later arrival — conservative staleness until a strictly newer
event arrives.

**Snapshot reconciliation** — a periodic sweep fetches provider truth
AFTER observing the watermark, then applies it through a decider that
re-checks the observed token against fresh state: any intervening write
drops the snapshot. On a token match it ALWAYS writes — even with no field
change — to advance the snapshot freshness bound `snapshotAt`, so a
delayed intermediate webhook cannot land after a no-op sweep. The
watermark identity is never touched: the snapshot repairs field drift
without disturbing the dedup identity of the events themselves.

**Invariant combinators** — host-declared write-path rules enforced
INSIDE the update decider, so they re-evaluate against fresh state on
every conflict: `sticky` (a flag that only ever flips one way — a
founding-member badge a later price reversion cannot clear) and
`firstWins` (a field group whose first write is permanent — consent
capture under concurrent deliveries). Declared per field in the host's
ledger definition, not hand-coded per host.

**Checkout reservation** — an atomic single-opportunity gate for
one-per-customer offers: mint a reservation inside a decider (refusing
when redeemed, live-subscribed, or already reserved and unexpired), read
the winning id back FROM STORAGE (the decider may re-run and mint
differently per run), release best-effort, expire by TTL so an abandoned
checkout never locks the account forever.

## Design decisions

### Ordering lives here, and only here

Receipts (webhooks) answer "have we completed this delivery?"; this ledger
answers "is this event newer than what we applied?". Keeping them separate
is what lets webhooks stay honestly at-least-once and lets this component
assume deliveries may arrive twice, late, and interleaved — which is the
actual provider contract.

### The always-write rule is load-bearing

A no-op snapshot MUST still advance the freshness bound. This is the
single least obvious rule in the reference implementation and the first
thing an optimizing refactor would delete; it is pinned by name, by test,
and by an AGENTS.md hard rule.

### Invariants are declared, not documented

`enforceLedgerInvariants` in the reference implementation is hand-written
per field. The component generalizes it into the two combinators above —
because an invariant enforced inside the decider survives concurrent
deliveries by construction, while an invariant enforced by caller
discipline survives until the second caller.

### The data boundary is absolute

The ledger stores provider IDENTIFIERS and DERIVED state — never a card
number, a raw webhook payload, a line item, or an amount. The codec is the
boundary, compile-checked complete (the ecosystem's
`Record<keyof T, StoredValue>` encode pattern).

### Provider-agnostic core, adapters translate

The core knows lifecycle states and ranks, not Stripe's vocabulary. The
Stripe adapter translates event types and subscription objects into
ledger applications and snapshot fetches; a future provider writes a
translation, not a ledger.

## Scope

### Non-goals

- **Processing payments, checkout UI, or provider API orchestration
  beyond the adapter's event/snapshot translation.** Hosts call their
  provider's SDK for checkout and portal flows.
- **Entitlement resolution.** What a subscription _grants_ is
  Authorization Core's job; this ledger is what the subscription _is_.
- **Receipt dedup and webhook authenticity.** `@pegma/webhooks` and the
  host, respectively.
- **Invoicing, tax, metering, usage billing, dunning orchestration.**
  Provider products; the ledger records their lifecycle outcomes only.
- **Merchant-of-record concerns.** Commercial posture, not code.

## Package architecture

Two packages, second gated on the first: `packages/billing-core`
(`@pegma/billing-core` — ledger, arbitration, combinators, reservation)
and `packages/billing-stripe` (`@pegma/billing-stripe` — event and
snapshot translation), created only when implementation begins per the
ecosystem rule. Dependencies: `@pegma/spine`, `@pegma/storage-core`,
pinned exactly; the Stripe adapter additionally takes verified events —
signature verification stays with the host, consistent with webhooks'
posture.

## Delivery phases

### Phase 1 — the arbitration core

Ledger collection, watermark, effective-watermark guard, lifecycle rank,
equal-second tie-breaking. The reference implementation's race tests are
the conformance bar; suite runs over memory and real Azurite.

### Phase 2 — invariant combinators and the reservation (this tree)

`sticky` and `firstWins` as declared rules; the single-opportunity
reservation with its read-winner-back semantics and TTL expiry.

### Phase 3 — snapshot reconciliation

The sweep, the domain CAS token, the always-write freshness rule — with
the delayed-intermediate-webhook scenario pinned as a named test.

### Phase 4 — the Stripe adapter

Translation from Stripe events and subscription snapshots, against the
reference application's real event corpus.

### Phase 5 — first consumer

RetireGolden swaps `repo.js`'s subscription-ledger half onto the package
(identity fields and account lifecycle stay host-side). Gated on that
application's operational calendar — never swap code under a soak or
mid-migration. Its existing billing/reconcile/webhook test suites are the
acceptance bar.

## Timing

Phase 2 is implemented in-tree. Later phases remain gated: snapshot
reconciliation (Phase 3) and the Stripe adapter (Phase 4) wait until a
named consumer needs them. Phase 5 (first consumer cutover) stays gated
on that application's operational calendar — never swap code under a soak
or mid-migration.

## Open questions

**One subscription per account.** The reference implementation is
single-subscription and so is v1. Multi-subscription (seats, add-ons)
changes the record shape and the reservation semantics; decide only when
a real consumer brings the requirement, and expect it to be a v2 shape
rather than a v1 option.

**Combinator expressiveness.** `sticky` and `firstWins` cover every
invariant the reference implementation has. Resist adding a general
predicate DSL — if a third combinator recurs across two consumers, add
that combinator, named.

**Reservation residence.** The single-opportunity reservation is
billing-adjacent commerce logic. It stays in v1 because the reference
implementation's version is entangled with subscription state (a live
subscription refuses a reservation); if a second commerce-shaped use
appears that has nothing to do with subscriptions, revisit.

**Relationship to `@pegma/authorization-stripe`.** Today that adapter
reads provider state shapes; once this ledger exists it could read the
ledger instead (one provider integration per host, not two). Coordinate
when Phase 4 lands — an upstream conversation, not a unilateral change.
