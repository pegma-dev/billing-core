# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Billing Core is the subscription ledger of **Pegma**, a family of
MIT-licensed packages a host application composes. Shared contracts live
in `@pegma/spine`; persistence in `@pegma/storage-core`; receipt dedup in
`@pegma/webhooks`; entitlement resolution in `@pegma/authorization-core`.
One repository per component, publishing under the `@pegma` scope. This
repository is plan-only until the extraction trigger in
`docs/PROJECT_PLAN.md` fires.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

A wrong ledger silently diverges a customer's access from what they pay
for. Weigh changes accordingly.

## Hard rules

**Arrival order proves nothing.** Every application decision goes through
the effective-watermark guard and lifecycle rank; equal-second, equal-rank
distinct events drop the LATER arrival (conservative staleness). Any path
that applies an event because it "just arrived" is wrong by construction.

**No-op snapshots still write.** On a reconciliation token match the
decider ALWAYS writes to advance the snapshot freshness bound, even when
no field changed — this is what stops a delayed intermediate webhook from
landing after a no-op sweep. Do not optimize the write away; it is the
single most tempting wrong refactor in this codebase.

**The watermark is a domain token, not a storage version.** The
`(eventAt, eventId)` pair lives in fields and crosses requests; the
snapshot decider re-checks it against freshly read state on every
conflict. Replacing it with the storage version token breaks
reconciliation across processes.

**Invariants run inside deciders.** `sticky` and `firstWins` re-evaluate
against fresh state on every conflict retry. An invariant checked before
the write call is checked against state that may no longer be true.

**Reservation ids are read back from storage.** The decider may re-run
and mint a different id per run; the caller's id is whatever the stored
record says, never a local variable.

**The data boundary is absolute.** Provider identifiers and derived state
only — never card data, raw payloads, line items, or amounts. The
compile-checked codec (`Record<keyof T, StoredValue>` encode) is the
enforcement point.

**No payment processing, no entitlements, no receipt dedup, no
invoicing/tax/metering.** Each belongs elsewhere (see the plan's
non-goals). Refuse regardless of how small the request looks.

**Test against real storage, races included.** Memory store and real
Azurite; the named scenarios — out-of-order application, same-second
rank arbitration, delayed-intermediate-after-sweep, concurrent
reservation, invariant races — are the specification.

## Reference points

The plan is `docs/PROJECT_PLAN.md`. The extraction source —
`api/src/lib/repo.js` and `api/src/lib/reconcile.js` in the RetireGolden
account API, and their tests — is the precedent wherever behaviour here is
ambiguous.
