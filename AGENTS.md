# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Billing Core is the subscription ledger of **Pegma**, a family of
MIT-licensed packages a host application composes. Shared contracts live
in `@pegma/spine`; persistence in `@pegma/storage-core`; receipt dedup in
`@pegma/webhooks`; entitlement resolution in `@pegma/authorization-core`.
One repository per component, publishing under the `@pegma` scope.

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

**Injected Clock and Logger only.** Never call `Date.now()` on a
production path. Log outcomes coarsely (account id, event id, applied) —
never payloads, amounts, or customer content.

**Pin `@pegma/*` deps exactly.** A caret would let CI resolve a version
nobody tested against.

**Never write literal control characters into source.** Write them as escape
sequences such as backslash-u-0000 through backslash-u-001F, and verify the
bytes after any tool-assisted edit.

## Packaging traps already paid for

Each published package needs its **own** README and LICENSE inside the package
directory; npm ignores files at the repository root. Each needs `prepack`
running the build. Each package `tsconfig.json` must exclude
`src/**/*.test.ts`, or compiled tests ship to consumers.

`runNpm` / release scripts must invoke a real npm CLI. Ignore `npm_execpath`
when pnpm set it, or pack/publish silently go through pnpm.

Lockfile sync: pnpm importers only record dependencies / devDependencies /
optionalDependencies. Do not require an importer `peerDependencies` section.
Caret-zero follows npm (`^0` → `<1.0.0`, `^0.0` → `<0.1.0`, `^0.0.3` is only
`0.0.3`). Exact prerelease pins match by identity. Strip pnpm peer suffixes
at the first `(`.

## Workflow

Work on a `cursor/*` branch and open a pull request. The gate is
`pnpm run format:check`, `pnpm run check`, `pnpm test` — all three, on Node 22
and 24.

Publishing is trusted-publisher only; no tokens exist. A release starts from a
protected signed annotated `vX.Y.Z` tag already on `origin/main`, followed by
`gh release create vX.Y.Z --verify-tag`. See `docs/RELEASING.md`.

## Where things stand

Phase 4: `@pegma/billing-core` (ledger collection, `(eventAt, eventId)`
watermark, effective-watermark guard, lifecycle-rank tie-break, declared
`sticky` / `firstWins` combinators, checkout reservation, snapshot
reconciliation) and `@pegma/billing-stripe` (Stripe event and snapshot
translation) are published at `0.1.1`. The `0.x` API is unstable. Phase 5
is the first-consumer `repo.js` swap — do not implement that here.

Siblings: [spine](https://github.com/pegma-dev/spine),
[storage-core](https://github.com/pegma-dev/storage-core),
[webhooks](https://github.com/pegma-dev/webhooks),
[authorization-core](https://github.com/pegma-dev/authorization-core).

## Reference points

The plan is `docs/PROJECT_PLAN.md`. The extraction source —
`api/src/lib/repo.js` and `api/src/lib/reconcile.js` in the RetireGolden
account API, and their tests — is the precedent wherever behaviour here is
ambiguous.
