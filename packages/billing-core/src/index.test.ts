import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import type { IsoTimestamp, Logger } from "@pegma/spine";
import { spawn as spawnChild } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from "@pegma/storage-core";
import { describe, expect, inject, it } from "vitest";

import {
  allocateAvailablePort,
  waitForStartup,
} from "../../../test/azurite.js";
import {
  applyLedgerInvariants,
  billingLedgerCollection,
  billingLedgerKey,
  createBillingLedger,
  decideLedgerApplication,
  decideLedgerSnapshot,
  decideReservation,
  DEFAULT_RESERVATION_TTL_MS,
  DEFAULT_SWEEP_LIMIT,
  effectiveWatermarkSecond,
  firstWins,
  hasReservationProvenance,
  type HostFromInvariants,
  isEventlessLedgerRow,
  isGrantingStatus,
  LIFECYCLE_RANK,
  lifecycleRank,
  observeWatermark,
  reservationIsLive,
  sticky,
  watermarksMatch,
  type LedgerEvent,
  type LedgerRecord,
  type LedgerSnapshot,
} from "./index.js";

declare module "vitest" {
  export interface ProvidedContext {
    azuriteTablePort: number;
  }
}

const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const CONNECTION_STRING = [
  "DefaultEndpointsProtocol=http",
  `AccountName=${ACCOUNT}`,
  `AccountKey=${KEY}`,
  `TableEndpoint=http://127.0.0.1:${inject("azuriteTablePort")}/${ACCOUNT};`,
].join(";");

const SECOND = "2026-08-15T16:00:00.000Z";
const SAME_SECOND_LATER_MS = "2026-08-15T16:00:00.400Z";
const EARLIER = "2026-08-15T15:59:59.000Z";
const LATER = "2026-08-15T16:00:01.000Z";
const SNAPSHOT_BOUND = "2026-08-15T16:05:00.000Z";

let tableCounter = 0;

function freshAzureStore(): Store {
  tableCounter += 1;
  const table = `billing${process.pid}t${tableCounter}`;
  const client = TableClient.fromConnectionString(CONNECTION_STRING, table, {
    allowInsecureConnection: true,
  });
  return createAzureTablesStore({ client });
}

function event<THost extends object = {}>(
  eventId: string,
  overrides: Partial<LedgerEvent<THost>> = {},
): LedgerEvent<THost> {
  return {
    eventId,
    eventAt: SECOND,
    status: "active",
    providerCustomerId: "cus_123",
    providerSubscriptionId: "sub_123",
    providerPriceId: "price_pro",
    plan: "pro",
    periodStartAt: "2026-08-01T00:00:00.000Z",
    periodEndAt: "2026-09-01T00:00:00.000Z",
    trialStartAt: null,
    trialEndAt: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function snapshot<THost extends object = {}>(
  overrides: Partial<LedgerSnapshot<THost>> = {},
): LedgerSnapshot<THost> {
  return {
    status: "active",
    providerCustomerId: "cus_123",
    providerSubscriptionId: "sub_123",
    providerPriceId: "price_pro",
    plan: "pro",
    periodStartAt: "2026-08-01T00:00:00.000Z",
    periodEndAt: "2026-09-01T00:00:00.000Z",
    trialStartAt: null,
    trialEndAt: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function record(
  accountId: string,
  overrides: Partial<LedgerRecord> = {},
): LedgerRecord {
  return {
    accountId,
    providerCustomerId: "cus_123",
    providerSubscriptionId: "sub_123",
    providerPriceId: "price_pro",
    status: "active",
    plan: "pro",
    periodStartAt: "2026-08-01T00:00:00.000Z",
    periodEndAt: "2026-09-01T00:00:00.000Z",
    trialStartAt: null,
    trialEndAt: null,
    cancelAtPeriodEnd: false,
    eventAt: SECOND,
    eventId: "evt_seed",
    snapshotAt: null,
    reservationId: null,
    reservationExpiresAt: null,
    reservationSeeded: false,
    offerRedeemed: false,
    ...overrides,
  };
}

function synchronizeFirstTwoUpdates(store: Store): Store {
  let arrivals = 0;
  let release = () => {};
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const delegate = store.collection(definition);
      if (definition.name !== "billingLedger") {
        return delegate;
      }
      return {
        ...delegate,
        update: (key, decide, options) =>
          delegate.update(
            key,
            async (current) => {
              arrivals += 1;
              if (arrivals <= 2) {
                if (arrivals === 2) {
                  release();
                }
                await bothArrived;
              }
              return decide(current);
            },
            options,
          ),
      };
    },
  };
}

function trackLedgerStorage(store: Store) {
  const calls = { update: 0, get: 0 };
  const tracked: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const delegate = store.collection(definition);
      return {
        ...delegate,
        async get(key) {
          calls.get += 1;
          return delegate.get(key);
        },
        async update(key, decide, options) {
          calls.update += 1;
          return delegate.update(key, decide, options);
        },
      };
    },
  };
  return { calls, store: tracked };
}

function ledgerConformance(name: string, freshStore: () => Store): void {
  describe(name, () => {
    it("creates a ledger row from the first event", async () => {
      const store = freshStore();
      const ledger = createBillingLedger({ store });
      const first = event("evt_first");

      const result = await ledger.apply("acct_create", first);
      expect(result.applied).toBe(true);
      expect(result.record).toEqual(
        record("acct_create", { eventId: "evt_first", offerRedeemed: true }),
      );
      expect(await ledger.get("acct_create")).toEqual(result.record);
    });

    it("applies a strictly newer event and drops an older one regardless of arrival order", async () => {
      const canceledLater = event("evt_canceled", {
        eventAt: LATER,
        status: "canceled",
        plan: "pro",
      });
      const activeEarlier = event("evt_active", {
        eventAt: EARLIER,
        status: "active",
        plan: "starter",
      });

      for (const [accountId, order] of [
        ["acct_ooo_new_first", [canceledLater, activeEarlier]],
        ["acct_ooo_old_first", [activeEarlier, canceledLater]],
      ] as const) {
        const store = freshStore();
        const ledger = createBillingLedger({ store });
        const results = [];
        for (const incoming of order) {
          results.push(await ledger.apply(accountId, incoming));
        }
        expect(results[results.length - 1]?.record.status).toBe("canceled");
        expect(results[results.length - 1]?.record.eventId).toBe(
          "evt_canceled",
        );
        expect(results[results.length - 1]?.record.eventAt).toBe(LATER);
        expect(await ledger.get(accountId)).toMatchObject({
          status: "canceled",
          eventId: "evt_canceled",
          plan: "pro",
        });
      }
    });

    it("same-second rank keeps canceled over active in both arrival orders", async () => {
      const canceled = event("evt_canceled", { status: "canceled" });
      const active = event("evt_active", { status: "active" });

      for (const [accountId, order] of [
        ["acct_rank_canceled_first", [canceled, active]],
        ["acct_rank_active_first", [active, canceled]],
      ] as const) {
        const store = freshStore();
        const ledger = createBillingLedger({ store });
        for (const incoming of order) {
          await ledger.apply(accountId, incoming);
        }
        expect(await ledger.get(accountId)).toMatchObject({
          status: "canceled",
          eventId: "evt_canceled",
          eventAt: SECOND,
        });
      }
    });

    it("same-second active outranks incomplete in both arrival orders", async () => {
      const active = event("evt_active", { status: "active" });
      const incomplete = event("evt_incomplete", { status: "incomplete" });

      for (const [accountId, order] of [
        ["acct_rank_active_first", [active, incomplete]],
        ["acct_rank_incomplete_first", [incomplete, active]],
      ] as const) {
        const store = freshStore();
        const ledger = createBillingLedger({ store });
        for (const incoming of order) {
          await ledger.apply(accountId, incoming);
        }
        expect(await ledger.get(accountId)).toMatchObject({
          status: "active",
          eventId: "evt_active",
        });
      }
    });

    it("equal rank at the equal second drops the later arrival", async () => {
      const store = freshStore();
      const ledger = createBillingLedger({ store });
      const first = event("evt_active_a", {
        status: "active",
        plan: "first",
      });
      const second = event("evt_active_b", {
        eventAt: SAME_SECOND_LATER_MS,
        status: "active",
        plan: "second",
      });

      expect(await ledger.apply("acct_equal_rank", first)).toMatchObject({
        applied: true,
      });
      expect(await ledger.apply("acct_equal_rank", second)).toMatchObject({
        applied: false,
      });
      expect(await ledger.get("acct_equal_rank")).toMatchObject({
        eventId: "evt_active_a",
        plan: "first",
        eventAt: SECOND,
      });
    });

    it("treats exact redelivery as an idempotent no-op", async () => {
      const store = freshStore();
      const rows = store.collection(billingLedgerCollection());
      const ledger = createBillingLedger({ store });
      const first = event("evt_repeat", { plan: "original" });

      expect(await ledger.apply("acct_redeliver", first)).toMatchObject({
        applied: true,
      });
      await rows.put(
        record("acct_redeliver", {
          eventId: "evt_repeat",
          plan: "original",
          cancelAtPeriodEnd: true,
        }),
      );

      const replay = event("evt_repeat", { plan: "mutated-on-retry" });
      const result = await ledger.apply("acct_redeliver", replay);
      expect(result.applied).toBe(false);
      expect(result.record).toMatchObject({
        eventId: "evt_repeat",
        plan: "original",
        cancelAtPeriodEnd: true,
      });
    });

    it("applies a strictly newer event even when its rank is lower", async () => {
      const store = freshStore();
      const ledger = createBillingLedger({ store });
      await ledger.apply(
        "acct_newer_lower",
        event("evt_canceled", { status: "canceled" }),
      );
      const result = await ledger.apply(
        "acct_newer_lower",
        event("evt_incomplete", {
          eventAt: LATER,
          status: "incomplete",
          plan: "retry",
        }),
      );
      expect(result.applied).toBe(true);
      expect(result.record).toMatchObject({
        status: "incomplete",
        eventId: "evt_incomplete",
        plan: "retry",
      });
    });

    it("does not apply onto an existing row whose watermark is missing", async () => {
      const store = freshStore();
      const rows = store.collection(billingLedgerCollection());
      await rows.put(
        record("acct_no_watermark", {
          status: "canceled",
          eventAt: null,
          eventId: null,
          snapshotAt: null,
          plan: "kept",
        }),
      );
      const ledger = createBillingLedger({ store });
      const result = await ledger.apply(
        "acct_no_watermark",
        event("evt_granting_arrival", { status: "active", plan: "resurrect" }),
      );
      expect(result.applied).toBe(false);
      expect(result.record).toMatchObject({
        status: "canceled",
        eventAt: null,
        eventId: null,
        snapshotAt: null,
        plan: "kept",
      });
    });

    it("orders expanded-year timestamps at true second resolution", async () => {
      const store = freshStore();
      const rows = store.collection(billingLedgerCollection());
      await rows.put(
        record("acct_expanded_year", {
          eventAt: "+010000-01-01T00:00:00.000Z",
          eventId: "evt_expanded_first",
          status: "active",
          plan: "first",
        }),
      );
      const ledger = createBillingLedger({ store });
      const result = await ledger.apply(
        "acct_expanded_year",
        event("evt_expanded_later", {
          eventAt: "+010000-01-01T00:00:01.000Z",
          status: "active",
          plan: "second",
        }),
      );
      expect(result.applied).toBe(true);
      expect(result.record).toMatchObject({
        eventId: "evt_expanded_later",
        eventAt: "+010000-01-01T00:00:01.000Z",
        plan: "second",
      });
    });

    it("drops a delayed event that is not strictly newer than max(eventAt, snapshotAt)", async () => {
      const store = freshStore();
      const rows = store.collection(billingLedgerCollection());
      await rows.put(
        record("acct_snapshot_bound", {
          status: "active",
          eventAt: EARLIER,
          eventId: "evt_applied",
          snapshotAt: SNAPSHOT_BOUND,
        }),
      );
      const ledger = createBillingLedger({ store });
      const delayed = event("evt_delayed_intermediate", {
        eventAt: SECOND,
        status: "past_due",
        plan: "should-not-land",
      });

      const result = await ledger.apply("acct_snapshot_bound", delayed);
      expect(result.applied).toBe(false);
      expect(result.record).toMatchObject({
        status: "active",
        eventId: "evt_applied",
        eventAt: EARLIER,
        snapshotAt: SNAPSHOT_BOUND,
        plan: "pro",
      });
    });

    it("preserves snapshotAt when a newer event applies", async () => {
      const store = freshStore();
      const rows = store.collection(billingLedgerCollection());
      await rows.put(
        record("acct_preserve_snapshot", {
          eventAt: EARLIER,
          eventId: "evt_old",
          snapshotAt: SECOND,
        }),
      );
      const ledger = createBillingLedger({ store });
      const result = await ledger.apply(
        "acct_preserve_snapshot",
        event("evt_new", { eventAt: LATER, status: "canceled" }),
      );
      expect(result.applied).toBe(true);
      expect(result.record.snapshotAt).toBe(SECOND);
      expect(result.record.eventId).toBe("evt_new");
    });

    it("does not let concurrent same-second applies resurrect a canceled row", async () => {
      const base = freshStore();
      const ledger = createBillingLedger({
        store: synchronizeFirstTwoUpdates(base),
      });
      await Promise.all([
        ledger.apply("acct_race", event("evt_active", { status: "active" })),
        ledger.apply(
          "acct_race",
          event("evt_canceled", { status: "canceled" }),
        ),
      ]);
      expect(
        await base
          .collection(billingLedgerCollection())
          .get(billingLedgerKey("acct_race")),
      ).toMatchObject({
        status: "canceled",
        eventId: "evt_canceled",
      });
    });

    it("isolates accounts from one another", async () => {
      const store = freshStore();
      const ledger = createBillingLedger({ store });
      await ledger.apply("acct_a", event("evt_a", { status: "canceled" }));
      await ledger.apply("acct_b", event("evt_b", { status: "active" }));

      expect(await ledger.get("acct_a")).toMatchObject({ status: "canceled" });
      expect(await ledger.get("acct_b")).toMatchObject({ status: "active" });
    });

    it("rejects unsafe account and event ids before storage", async () => {
      const base = freshStore();
      const tracked = trackLedgerStorage(base);
      const ledger = createBillingLedger({ store: tracked.store });

      expect(() => billingLedgerKey("bad/account")).toThrow(/account id/);
      expect(() => billingLedgerKey("")).toThrow(/account id/);
      expect(() => billingLedgerKey("a".repeat(257))).toThrow(/account id/);
      await expect(
        ledger.apply("bad#account", event("evt_ok")),
      ).rejects.toThrow(/account id/);
      await expect(ledger.apply("acct_ok", event("bad/event"))).rejects.toThrow(
        /event id/,
      );
      expect(tracked.calls.update).toBe(0);
      expect(
        await base.collection(billingLedgerCollection()).scan({ limit: 1 }),
      ).toEqual({
        records: [],
        nextCursor: null,
      });
    });

    it("rejects invalid event timestamps before a write can persist", async () => {
      const base = freshStore();
      const tracked = trackLedgerStorage(base);
      const ledger = createBillingLedger({ store: tracked.store });

      for (const invalid of [
        "0",
        "08/15/2026",
        "2026-08-15",
        "2026-08-15T16:00:00Z",
      ]) {
        await expect(
          ledger.apply(
            "acct_bad_time",
            event("evt_bad_time", { eventAt: invalid as IsoTimestamp }),
          ),
        ).rejects.toThrow(/timestamp/);
      }
      expect(tracked.calls.update).toBe(0);
      expect(await ledger.get("acct_bad_time")).toBeNull();
    });

    it("logs apply and ignore outcomes without payload or amount fields", async () => {
      const entries: Array<{
        level: string;
        message: string;
        fields?: Readonly<Record<string, unknown>>;
      }> = [];
      const logger: Logger = {
        log(level, message, fields) {
          entries.push({
            level,
            message,
            ...(fields === undefined ? {} : { fields }),
          });
        },
      };
      const ledger = createBillingLedger({
        store: freshStore(),
        logger,
      });
      await ledger.apply(
        "acct_logged",
        event("evt_new", { status: "canceled" }),
      );
      await ledger.apply(
        "acct_logged",
        event("evt_stale", { eventAt: EARLIER }),
      );

      expect(entries).toEqual([
        {
          level: "info",
          message: "Billing ledger event applied",
          fields: {
            accountId: "acct_logged",
            eventId: "evt_new",
            applied: true,
          },
        },
        {
          level: "info",
          message: "Billing ledger event ignored",
          fields: {
            accountId: "acct_logged",
            eventId: "evt_stale",
            applied: false,
          },
        },
      ]);
      expect(JSON.stringify(entries)).not.toContain("payload");
      expect(JSON.stringify(entries)).not.toContain("amount");
    });
  });
}

ledgerConformance("billing ledger / memory", createMemoryStore);
ledgerConformance("billing ledger / Azure Tables", freshAzureStore);

describe("Azurite test lifecycle", () => {
  it("rejects when the child process cannot start", async () => {
    const missing = spawnChild(
      `missing-azurite-executable-${process.pid}-${Date.now()}`,
    );

    await expect(waitForStartup(missing, 65_534, 1_000)).rejects.toThrow();
  });

  it("allocates around an occupied loopback port", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      throw new Error("Could not inspect the occupied test port.");
    }

    try {
      expect(await allocateAvailablePort()).not.toBe(address.port);
      expect(inject("azuriteTablePort")).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("does not mistake an unrelated listener for the spawned service", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      throw new Error("Could not inspect the unrelated listener port.");
    }
    const unrelated = spawnChild(process.execPath, [
      "-e",
      "setTimeout(() => {}, 5000)",
    ]);

    try {
      await expect(
        waitForStartup(unrelated, address.port, 300),
      ).rejects.toThrow(/within 300ms/);
    } finally {
      unrelated.kill();
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});

describe("lifecycle rank", () => {
  it("ranks terminal non-granting above granting, and granting above incomplete", () => {
    expect(lifecycleRank("canceled")).toBeGreaterThan(lifecycleRank("active"));
    expect(lifecycleRank("unpaid")).toBeGreaterThan(lifecycleRank("trialing"));
    expect(lifecycleRank("active")).toBeGreaterThan(
      lifecycleRank("incomplete"),
    );
    expect(lifecycleRank("active")).toBe(lifecycleRank("trialing"));
    expect(lifecycleRank("active")).toBe(lifecycleRank("past_due"));
    expect(lifecycleRank("canceled")).toBe(lifecycleRank("unpaid"));
    expect(LIFECYCLE_RANK.canceled).toBe(2);
  });
});

function unixSecond(timestamp: string): number {
  return Math.floor(Date.parse(timestamp) / 1000);
}

describe("effective watermark and application decider", () => {
  it("uses max(eventAt, snapshotAt) at second resolution", () => {
    expect(
      effectiveWatermarkSecond({
        eventAt: EARLIER,
        snapshotAt: SNAPSHOT_BOUND,
      }),
    ).toBe(unixSecond(SNAPSHOT_BOUND));
    expect(
      effectiveWatermarkSecond({ eventAt: SECOND, snapshotAt: null }),
    ).toBe(unixSecond(SECOND));
    expect(
      effectiveWatermarkSecond({ eventAt: null, snapshotAt: null }),
    ).toBeNull();
  });

  it("derives the second from the parsed instant so expanded years do not collide", () => {
    const first = "+010000-01-01T00:00:00.000Z";
    const laterSameMinute = "+010000-01-01T00:00:01.000Z";
    expect(first.slice(0, 19)).toBe(laterSameMinute.slice(0, 19));
    expect(effectiveWatermarkSecond({ eventAt: first, snapshotAt: null })).toBe(
      unixSecond(first),
    );
    expect(
      effectiveWatermarkSecond({
        eventAt: laterSameMinute,
        snapshotAt: null,
      }),
    ).toBe(unixSecond(laterSameMinute));
    expect(
      decideLedgerApplication(
        record("acct", {
          eventAt: first,
          eventId: "evt_expanded_first",
          status: "active",
          plan: "first",
        }),
        "acct",
        event("evt_expanded_later", {
          eventAt: laterSameMinute,
          status: "active",
          plan: "second",
        }),
      ),
    ).toMatchObject({
      action: "write",
      value: { eventId: "evt_expanded_later", plan: "second" },
    });
  });

  it("keeps an existing row when the watermark is missing instead of applying by arrival", () => {
    expect(
      decideLedgerApplication(
        record("acct", {
          status: "canceled",
          eventAt: null,
          eventId: null,
          snapshotAt: null,
        }),
        "acct",
        event("evt_granting_arrival", { status: "active" }),
      ),
    ).toEqual({ action: "keep", reason: "stale" });
  });

  it("does not consult arrival order when two same-second events differ in rank", () => {
    const canceled = decideLedgerApplication(
      record("acct", { status: "active", eventId: "evt_active" }),
      "acct",
      event("evt_canceled", { status: "canceled" }),
    );
    const active = decideLedgerApplication(
      record("acct", { status: "canceled", eventId: "evt_canceled" }),
      "acct",
      event("evt_active", { status: "active" }),
    );
    expect(canceled).toMatchObject({
      action: "write",
      value: { status: "canceled", eventId: "evt_canceled" },
    });
    expect(active).toEqual({ action: "keep", reason: "equal-rank" });
  });
});

describe("billing ledger codec", () => {
  const codec = billingLedgerCollection().codec;

  it("encodes exactly the declared fields and drops cast-in payload data", () => {
    const value = {
      ...record("acct_boundary"),
      payload: { customer: "secret" },
      amount: 1999,
      card: "4242",
    };

    expect(codec.encode(value)).toEqual({
      accountId: "acct_boundary",
      providerCustomerId: "cus_123",
      providerSubscriptionId: "sub_123",
      providerPriceId: "price_pro",
      status: "active",
      plan: "pro",
      periodStartAt: "2026-08-01T00:00:00.000Z",
      periodEndAt: "2026-09-01T00:00:00.000Z",
      trialStartAt: null,
      trialEndAt: null,
      cancelAtPeriodEnd: false,
      eventAt: SECOND,
      eventId: "evt_seed",
      snapshotAt: null,
      reservationId: null,
      reservationExpiresAt: null,
      reservationSeeded: false,
      offerRedeemed: false,
    });
  });

  it("does not treat a blank unknown-status decode as reservation provenance", () => {
    const decoded = codec.decode({
      accountId: "acct_unknown_blank",
      status: "unknown",
    });
    expect(decoded).toMatchObject({
      status: "incomplete",
      reservationSeeded: false,
      reservationId: null,
      reservationExpiresAt: null,
      eventAt: null,
      eventId: null,
    });
    expect(hasReservationProvenance(decoded)).toBe(false);
    expect(isEventlessLedgerRow(decoded)).toBe(false);
    expect(
      decideLedgerApplication(
        decoded,
        "acct_unknown_blank",
        event("evt_granting_arrival", { status: "active" }),
      ),
    ).toEqual({ action: "keep", reason: "stale" });
  });

  it("decodes unknown status to incomplete so a corrupt row cannot grant", () => {
    expect(
      codec.decode({
        accountId: "acct_junk",
        status: "unknown",
        cancelAtPeriodEnd: "yes",
      }),
    ).toMatchObject({
      accountId: "acct_junk",
      status: "incomplete",
      cancelAtPeriodEnd: false,
      eventAt: null,
      snapshotAt: null,
    });
  });
});

describe("production clock discipline", () => {
  it("never calls Date.now on a production path", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/billing-core/src/index.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/Date\.now\s*\(/u);
  });
});

function controllableClock(start: IsoTimestamp) {
  let current = start;
  return {
    now: () => current,
    set(at: IsoTimestamp) {
      current = at;
    },
    advance(ms: number) {
      current = new Date(
        Date.parse(current) + ms,
      ).toISOString() as IsoTimestamp;
    },
  };
}

const HOST_FIELDS = {
  foundingMember: sticky(),
  consentAt: firstWins("consent"),
  consentVersion: firstWins("consent"),
};
type Host = HostFromInvariants<typeof HOST_FIELDS>;

function conflictFirstWrite(store: Store): Store {
  let attempts = 0;
  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const delegate = store.collection(definition);
      if (definition.name !== "billingLedger") {
        return delegate;
      }
      return {
        ...delegate,
        update: (key, decide, options) =>
          delegate.update(
            key,
            async (current) => {
              const decision = await decide(current);
              attempts += 1;
              if (attempts === 1 && decision.action === "write") {
                await delegate.put(
                  current === null
                    ? (record("acct_conflict_seed", {
                        accountId: String(key.partition),
                        status: "incomplete",
                        providerCustomerId: null,
                        providerSubscriptionId: null,
                        providerPriceId: null,
                        plan: null,
                        periodStartAt: null,
                        periodEndAt: null,
                        trialStartAt: null,
                        trialEndAt: null,
                        cancelAtPeriodEnd: false,
                        eventAt: null,
                        eventId: null,
                        snapshotAt: null,
                        offerRedeemed: false,
                      }) as T)
                    : current,
                );
              }
              return decision;
            },
            options,
          ),
      };
    },
  };
}

function invariantsAndReservation(name: string, freshStore: () => Store): void {
  describe(name, () => {
    it("sticky one-way flip survives a later price reversion", async () => {
      const store = freshStore();
      const ledger = createBillingLedger({
        store,
        fields: HOST_FIELDS,
      });
      await ledger.apply(
        "acct_sticky",
        event("evt_founding", {
          fields: { foundingMember: true, consentAt: SECOND },
        }),
      );
      const reverted = await ledger.apply(
        "acct_sticky",
        event("evt_reversion", {
          eventAt: LATER,
          status: "active",
          plan: "starter",
          providerPriceId: "price_starter",
          fields: { foundingMember: false, consentAt: LATER },
        }),
      );
      expect(reverted.applied).toBe(true);
      expect(reverted.record).toMatchObject({
        plan: "starter",
        foundingMember: true,
        consentAt: SECOND,
        offerRedeemed: true,
      });
    });

    it("sticky stays true under concurrent deliveries that try to clear it", async () => {
      const base = freshStore();
      const rows = base.collection(billingLedgerCollection(HOST_FIELDS));
      await rows.put({
        ...record("acct_sticky_race", {
          eventAt: EARLIER,
          eventId: "evt_seed",
        }),
        foundingMember: true,
        consentAt: EARLIER,
        consentVersion: "v1",
      });
      const ledger = createBillingLedger({
        store: synchronizeFirstTwoUpdates(base),
        fields: HOST_FIELDS,
      });
      await Promise.all([
        ledger.apply(
          "acct_sticky_race",
          event("evt_clear_a", {
            eventAt: LATER,
            status: "active",
            fields: { foundingMember: false },
          }),
        ),
        ledger.apply(
          "acct_sticky_race",
          event("evt_clear_b", {
            eventAt: "2026-08-15T16:00:02.000Z",
            status: "canceled",
            fields: { foundingMember: false },
          }),
        ),
      ]);
      expect(await ledger.get("acct_sticky_race")).toMatchObject({
        foundingMember: true,
        consentAt: EARLIER,
        consentVersion: "v1",
      });
    });

    it("firstWins keeps the first consent group under concurrent deliveries", async () => {
      const base = freshStore();
      const rows = base.collection(billingLedgerCollection(HOST_FIELDS));
      await rows.put({
        ...record("acct_first_wins", {
          eventAt: EARLIER,
          eventId: "evt_seed",
          status: "incomplete",
          offerRedeemed: false,
        }),
        foundingMember: false,
        consentAt: null,
        consentVersion: null,
      });
      const ledger = createBillingLedger({
        store: synchronizeFirstTwoUpdates(base),
        fields: HOST_FIELDS,
      });
      await Promise.all([
        ledger.apply(
          "acct_first_wins",
          event("evt_consent_a", {
            eventAt: LATER,
            status: "active",
            fields: { consentAt: LATER, consentVersion: "a" },
          }),
        ),
        ledger.apply(
          "acct_first_wins",
          event("evt_consent_b", {
            eventAt: "2026-08-15T16:00:02.000Z",
            status: "active",
            fields: {
              consentAt: "2026-08-15T16:00:02.000Z",
              consentVersion: "b",
            },
          }),
        ),
      ]);
      const stored = await ledger.get("acct_first_wins");
      expect(["a", "b"]).toContain(stored?.consentVersion);
      expect(stored?.consentAt).toBe(
        stored?.consentVersion === "a" ? LATER : "2026-08-15T16:00:02.000Z",
      );
      const later = await ledger.apply(
        "acct_first_wins",
        event("evt_consent_c", {
          eventAt: "2026-08-15T16:00:03.000Z",
          status: "canceled",
          fields: {
            consentAt: "2026-08-15T16:00:03.000Z",
            consentVersion: "c",
          },
        }),
      );
      expect(later.applied).toBe(true);
      expect(later.record.consentVersion).toBe(stored?.consentVersion);
      expect(later.record.consentAt).toBe(stored?.consentAt);
    });

    it("mints one reservation and reads the winning id back from storage", async () => {
      const clock = controllableClock(SECOND);
      const minted: string[] = [];
      const base = freshStore();
      const ledger = createBillingLedger({
        store: conflictFirstWrite(base),
        clock,
        newId: () => {
          const id = `rsv_mint_${minted.length}`;
          minted.push(id);
          return id;
        },
      });
      const result = await ledger.reserve("acct_read_back");
      expect(result).toEqual({
        reserved: true,
        reservationId: minted[minted.length - 1],
        expiresAt: "2026-08-15T16:30:00.000Z",
      });
      expect(minted.length).toBeGreaterThanOrEqual(2);
      expect(result.reserved).toBe(true);
      if (result.reserved) {
        expect(result.reservationId).not.toBe(minted[0]);
        expect(
          await base
            .collection(billingLedgerCollection())
            .get(billingLedgerKey("acct_read_back")),
        ).toMatchObject({
          reservationId: result.reservationId,
          reservationExpiresAt: result.expiresAt,
        });
      }
    });

    it("concurrent reservation admits exactly one winner", async () => {
      const clock = controllableClock(SECOND);
      let next = 0;
      const ledger = createBillingLedger({
        store: synchronizeFirstTwoUpdates(freshStore()),
        clock,
        newId: () => `rsv_race_${(next += 1)}`,
      });
      const [left, right] = await Promise.all([
        ledger.reserve("acct_rsv_race"),
        ledger.reserve("acct_rsv_race"),
      ]);
      const outcomes = [left, right];
      const winners = outcomes.filter((outcome) => outcome.reserved);
      const losers = outcomes.filter((outcome) => !outcome.reserved);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toEqual({ reserved: false, reason: "reserved" });
      const stored = await ledger.get("acct_rsv_race");
      expect(winners[0]?.reserved).toBe(true);
      if (winners[0]?.reserved) {
        expect(stored?.reservationId).toBe(winners[0].reservationId);
        expect(stored?.reservationExpiresAt).toBe(winners[0].expiresAt);
      }
    });

    it("refuses when redeemed, live-subscribed, or already reserved", async () => {
      const clock = controllableClock(SECOND);
      const ledger = createBillingLedger({ store: freshStore(), clock });

      expect(await ledger.reserve("acct_live")).toMatchObject({
        reserved: true,
      });
      expect(await ledger.reserve("acct_live")).toEqual({
        reserved: false,
        reason: "reserved",
      });

      const subscribedStore = freshStore();
      await subscribedStore
        .collection(billingLedgerCollection())
        .put(record("acct_sub", { status: "active", offerRedeemed: false }));
      expect(
        await createBillingLedger({ store: subscribedStore, clock }).reserve(
          "acct_sub",
        ),
      ).toEqual({
        reserved: false,
        reason: "subscribed",
      });

      await ledger.apply("acct_redeemed", event("evt_active"));
      await ledger.apply(
        "acct_redeemed",
        event("evt_canceled", { eventAt: LATER, status: "canceled" }),
      );
      expect(await ledger.get("acct_redeemed")).toMatchObject({
        status: "canceled",
        offerRedeemed: true,
        reservationId: null,
      });
      expect(await ledger.reserve("acct_redeemed")).toEqual({
        reserved: false,
        reason: "redeemed",
      });
    });

    it("expires an abandoned reservation by TTL from the injected clock", async () => {
      const clock = controllableClock(SECOND);
      const ledger = createBillingLedger({
        store: freshStore(),
        clock,
        reservationTtlMs: 60_000,
      });
      const first = await ledger.reserve("acct_ttl");
      expect(first).toMatchObject({
        reserved: true,
        expiresAt: "2026-08-15T16:01:00.000Z",
      });
      clock.advance(59_999);
      expect(await ledger.reserve("acct_ttl")).toEqual({
        reserved: false,
        reason: "reserved",
      });
      clock.advance(1);
      const again = await ledger.reserve("acct_ttl");
      expect(again.reserved).toBe(true);
      if (first.reserved && again.reserved) {
        expect(again.reservationId).not.toBe(first.reservationId);
        expect(again.expiresAt).toBe("2026-08-15T16:02:00.000Z");
      }
    });

    it("releases a reservation best-effort and lets the account reserve again", async () => {
      const clock = controllableClock(SECOND);
      const ledger = createBillingLedger({ store: freshStore(), clock });
      const minted = await ledger.reserve("acct_release");
      expect(minted.reserved).toBe(true);
      if (!minted.reserved) {
        throw new Error("expected a reservation");
      }
      expect(
        await ledger.release("acct_release", minted.reservationId),
      ).toEqual({ released: true });
      expect(
        await ledger.release("acct_release", minted.reservationId),
      ).toEqual({ released: false });
      expect(await ledger.release("acct_release", "rsv_other")).toEqual({
        released: false,
      });
      const again = await ledger.reserve("acct_release");
      expect(again.reserved).toBe(true);
      if (!again.reserved) {
        throw new Error("expected a second reservation");
      }
      expect(again.reservationId).not.toBe(minted.reservationId);
      expect(await ledger.release("acct_release", again.reservationId)).toEqual(
        {
          released: true,
        },
      );
      const firstEvent = await ledger.apply(
        "acct_release",
        event("evt_after_release", { status: "incomplete" }),
      );
      expect(firstEvent.applied).toBe(true);
      expect(firstEvent.record.reservationSeeded).toBe(true);
    });

    it("applies the first event onto a reservation-only row and keeps the reservation until granting", async () => {
      const clock = controllableClock(SECOND);
      const ledger = createBillingLedger({ store: freshStore(), clock });
      const minted = await ledger.reserve("acct_after_rsv");
      expect(minted.reserved).toBe(true);
      const incomplete = await ledger.apply(
        "acct_after_rsv",
        event("evt_incomplete", { status: "incomplete", plan: "pro" }),
      );
      expect(incomplete.applied).toBe(true);
      expect(incomplete.record).toMatchObject({
        status: "incomplete",
        plan: "pro",
        offerRedeemed: false,
        reservationId: minted.reserved ? minted.reservationId : null,
      });
      const active = await ledger.apply(
        "acct_after_rsv",
        event("evt_active", { eventAt: LATER, status: "active" }),
      );
      expect(active.applied).toBe(true);
      expect(active.record).toMatchObject({
        status: "active",
        offerRedeemed: true,
        reservationId: null,
        reservationExpiresAt: null,
      });
    });

    it("does not treat a blank decoded corrupt row as reservation-only", async () => {
      const store = freshStore();
      const rows = store.collection(billingLedgerCollection());
      const decoded = billingLedgerCollection().codec.decode({
        accountId: "acct_unknown_blank",
        status: "unknown",
      });
      expect(hasReservationProvenance(decoded)).toBe(false);
      expect(isEventlessLedgerRow(decoded)).toBe(false);
      await rows.put(decoded);
      const ledger = createBillingLedger({
        store,
        clock: controllableClock(SECOND),
      });
      const result = await ledger.apply(
        "acct_unknown_blank",
        event("evt_granting_arrival", { status: "active", plan: "resurrect" }),
      );
      expect(result.applied).toBe(false);
      expect(result.record).toMatchObject({
        status: "incomplete",
        eventAt: null,
        eventId: null,
        plan: null,
      });
    });

    it("firstWins keeps an empty-string first write under a later event", async () => {
      const store = freshStore();
      const rows = store.collection(billingLedgerCollection(HOST_FIELDS));
      await rows.put({
        ...record("acct_empty_first", {
          eventAt: EARLIER,
          eventId: "evt_seed",
          status: "incomplete",
          offerRedeemed: false,
        }),
        foundingMember: false,
        consentAt: "",
        consentVersion: "",
      });
      const ledger = createBillingLedger({
        store,
        fields: HOST_FIELDS,
      });
      const later = await ledger.apply(
        "acct_empty_first",
        event("evt_consent_later", {
          eventAt: LATER,
          status: "active",
          fields: { consentAt: LATER, consentVersion: "later" },
        }),
      );
      expect(later.applied).toBe(true);
      expect(later.record).toMatchObject({
        consentAt: "",
        consentVersion: "",
      });
    });

    it("allows reserve after a terminal event that never granted", async () => {
      const clock = controllableClock(SECOND);
      const ledger = createBillingLedger({ store: freshStore(), clock });
      const canceled = await ledger.apply(
        "acct_never_granted",
        event("evt_canceled", { status: "canceled" }),
      );
      expect(canceled.applied).toBe(true);
      expect(canceled.record.offerRedeemed).toBe(false);
      expect(await ledger.reserve("acct_never_granted")).toMatchObject({
        reserved: true,
      });

      const reserved = await ledger.reserve("acct_abandoned_cancel");
      expect(reserved.reserved).toBe(true);
      if (!reserved.reserved) {
        throw new Error("expected a reservation");
      }
      const terminal = await ledger.apply(
        "acct_abandoned_cancel",
        event("evt_unpaid", { status: "unpaid" }),
      );
      expect(terminal.applied).toBe(true);
      expect(terminal.record.offerRedeemed).toBe(false);
      expect(terminal.record.reservationId).toBe(reserved.reservationId);
      expect(
        await ledger.release("acct_abandoned_cancel", reserved.reservationId),
      ).toEqual({ released: true });
      expect(await ledger.reserve("acct_abandoned_cancel")).toMatchObject({
        reserved: true,
      });
    });

    it("redeems a Phase 1 live row when a later non-granting event applies", async () => {
      const store = freshStore();
      await store.collection(billingLedgerCollection()).put(
        record("acct_phase1", {
          status: "active",
          offerRedeemed: false,
          reservationSeeded: false,
        }),
      );
      const ledger = createBillingLedger({
        store,
        clock: controllableClock(SECOND),
      });
      const canceled = await ledger.apply(
        "acct_phase1",
        event("evt_canceled", { eventAt: LATER, status: "canceled" }),
      );
      expect(canceled.applied).toBe(true);
      expect(canceled.record.offerRedeemed).toBe(true);
      expect(await ledger.reserve("acct_phase1")).toEqual({
        reserved: false,
        reason: "redeemed",
      });
    });

    it("does not apply onto a corrupt canceled row that lacks a watermark", async () => {
      const store = freshStore();
      const rows = store.collection(billingLedgerCollection());
      await rows.put(
        record("acct_corrupt_reserved", {
          status: "canceled",
          eventAt: null,
          eventId: null,
          snapshotAt: null,
          plan: "kept",
          reservationId: "rsv_stale",
          reservationExpiresAt: LATER,
        }),
      );
      const ledger = createBillingLedger({
        store,
        clock: controllableClock(SECOND),
      });
      const result = await ledger.apply(
        "acct_corrupt_reserved",
        event("evt_granting_arrival", { status: "active", plan: "resurrect" }),
      );
      expect(result.applied).toBe(false);
      expect(result.record).toMatchObject({
        status: "canceled",
        plan: "kept",
        reservationId: "rsv_stale",
      });
    });
  });
}

invariantsAndReservation(
  "invariants and reservation / memory",
  createMemoryStore,
);
invariantsAndReservation(
  "invariants and reservation / Azure Tables",
  freshAzureStore,
);

describe("declared invariants", () => {
  it("rejects host field names that collide with core ledger fields", () => {
    expect(() =>
      billingLedgerCollection({ status: sticky() } as never),
    ).toThrow(/host ledger field/);
    expect(() =>
      createBillingLedger({
        store: createMemoryStore(),
        fields: { "bad-name": sticky() } as never,
      }),
    ).toThrow(/host ledger field/);
  });

  it("encodes declared host fields and still drops cast-in payload data", () => {
    const codec = billingLedgerCollection(HOST_FIELDS).codec;
    const value = {
      ...record("acct_host"),
      foundingMember: true,
      consentAt: SECOND,
      consentVersion: "v1",
      payload: { customer: "secret" },
      amount: 1999,
    };
    expect(codec.encode(value)).toEqual({
      accountId: "acct_host",
      providerCustomerId: "cus_123",
      providerSubscriptionId: "sub_123",
      providerPriceId: "price_pro",
      status: "active",
      plan: "pro",
      periodStartAt: "2026-08-01T00:00:00.000Z",
      periodEndAt: "2026-09-01T00:00:00.000Z",
      trialStartAt: null,
      trialEndAt: null,
      cancelAtPeriodEnd: false,
      eventAt: SECOND,
      eventId: "evt_seed",
      snapshotAt: null,
      reservationId: null,
      reservationExpiresAt: null,
      reservationSeeded: false,
      offerRedeemed: false,
      foundingMember: true,
      consentAt: SECOND,
      consentVersion: "v1",
    });
  });

  it("rejects declared host fields that would persist forbidden data", () => {
    for (const name of ["amount", "cardData", "rawPayload", "lineItems"]) {
      expect(() => billingLedgerCollection({ [name]: firstWins() })).toThrow(
        /card data, raw payloads, line items, or amounts/,
      );
    }
    expect(() =>
      createBillingLedger({
        store: createMemoryStore(),
        fields: { amount: sticky() },
      }),
    ).toThrow(/card data, raw payloads, line items, or amounts/);
  });

  it("re-evaluates sticky and firstWins against fresh current state", () => {
    const current = {
      ...record("acct"),
      foundingMember: true,
      consentAt: EARLIER,
      consentVersion: "first",
    };
    expect(
      applyLedgerInvariants<Host>(
        current,
        { foundingMember: false, consentAt: LATER, consentVersion: "second" },
        HOST_FIELDS,
      ),
    ).toEqual({
      foundingMember: true,
      consentAt: EARLIER,
      consentVersion: "first",
    });
    expect(
      applyLedgerInvariants<Host>(
        {
          ...record("acct"),
          foundingMember: false,
          consentAt: null,
          consentVersion: null,
        },
        { foundingMember: true, consentAt: SECOND, consentVersion: "v1" },
        HOST_FIELDS,
      ),
    ).toEqual({
      foundingMember: true,
      consentAt: SECOND,
      consentVersion: "v1",
    });
  });

  it("firstWins freezes an empty-string first write", () => {
    expect(
      applyLedgerInvariants<Host>(
        {
          ...record("acct"),
          foundingMember: false,
          consentAt: "",
          consentVersion: "",
        },
        { consentAt: LATER, consentVersion: "later" },
        HOST_FIELDS,
      ),
    ).toEqual({
      foundingMember: false,
      consentAt: "",
      consentVersion: "",
    });
  });
});

describe("checkout reservation decider", () => {
  it("refuses redeemed, subscribed, and live reservations without writing", () => {
    expect(
      decideReservation(
        record("acct", { offerRedeemed: true }),
        "acct",
        SECOND,
        "rsv_new",
        LATER,
      ),
    ).toEqual({ action: "keep", reason: "redeemed" });
    expect(
      decideReservation(
        record("acct", { status: "canceled", offerRedeemed: false }),
        "acct",
        SECOND,
        "rsv_new",
        LATER,
      ),
    ).toMatchObject({
      action: "write",
      value: { reservationId: "rsv_new", offerRedeemed: false },
    });
    expect(
      decideReservation(
        record("acct", { status: "trialing" }),
        "acct",
        SECOND,
        "rsv_new",
        LATER,
      ),
    ).toEqual({ action: "keep", reason: "subscribed" });
    expect(
      decideReservation(
        record("acct", {
          status: "incomplete",
          reservationId: "rsv_live",
          reservationExpiresAt: LATER,
        }),
        "acct",
        SECOND,
        "rsv_new",
        SNAPSHOT_BOUND,
      ),
    ).toEqual({ action: "keep", reason: "reserved" });
  });

  it("treats an expired or unparseable reservation as free", () => {
    const expired = decideReservation(
      record("acct", {
        status: "incomplete",
        reservationId: "rsv_old",
        reservationExpiresAt: SECOND,
      }),
      "acct",
      SECOND,
      "rsv_new",
      LATER,
    );
    expect(expired).toMatchObject({
      action: "write",
      value: { reservationId: "rsv_new", reservationExpiresAt: LATER },
    });
    expect(
      reservationIsLive(
        { reservationId: "rsv_old", reservationExpiresAt: "not-a-time" },
        SECOND,
      ),
    ).toBe(false);
  });

  it("creates a reservation-only row that the first event can still apply onto", () => {
    const reserved = decideReservation(
      null,
      "acct_blank",
      SECOND,
      "rsv_1",
      LATER,
    );
    expect(reserved.action).toBe("write");
    if (reserved.action !== "write") {
      return;
    }
    expect(hasReservationProvenance(reserved.value)).toBe(true);
    expect(isEventlessLedgerRow(reserved.value)).toBe(true);
    expect(
      decideLedgerApplication(
        reserved.value,
        "acct_blank",
        event("evt_first", { status: "incomplete" }),
      ),
    ).toMatchObject({
      action: "write",
      value: { eventId: "evt_first", reservationId: "rsv_1" },
    });
  });

  it("requires an injected clock and never uses Date.now for TTL", async () => {
    const ledger = createBillingLedger({ store: createMemoryStore() });
    await expect(ledger.reserve("acct_no_clock")).rejects.toThrow(/Clock/);
    expect(DEFAULT_RESERVATION_TTL_MS).toBe(30 * 60 * 1000);
    expect(isGrantingStatus("active")).toBe(true);
    expect(isGrantingStatus("canceled")).toBe(false);
  });
});

describe("snapshot decider", () => {
  it("always writes on a token match even when no field changed", () => {
    const current = record("acct", { snapshotAt: null });
    const decision = decideLedgerSnapshot(
      current,
      observeWatermark(current),
      snapshot(),
      SNAPSHOT_BOUND,
    );
    expect(decision).toMatchObject({
      action: "write",
      value: {
        eventId: "evt_seed",
        eventAt: SECOND,
        snapshotAt: SNAPSHOT_BOUND,
        status: "active",
        plan: "pro",
      },
    });
  });

  it("repairs field drift without touching watermark identity", () => {
    const current = record("acct", { plan: "stale", snapshotAt: EARLIER });
    const decision = decideLedgerSnapshot(
      current,
      observeWatermark(current),
      snapshot({ plan: "pro", status: "past_due" }),
      SNAPSHOT_BOUND,
    );
    expect(decision.action).toBe("write");
    if (decision.action !== "write") {
      return;
    }
    expect(decision.value).toMatchObject({
      plan: "pro",
      status: "past_due",
      eventId: "evt_seed",
      eventAt: SECOND,
      snapshotAt: SNAPSHOT_BOUND,
    });
  });

  it("drops the snapshot when the observed token no longer matches", () => {
    expect(
      decideLedgerSnapshot(
        record("acct", { eventId: "evt_newer", eventAt: LATER }),
        { eventAt: SECOND, eventId: "evt_seed" },
        snapshot({ plan: "should-not-land" }),
        SNAPSHOT_BOUND,
      ),
    ).toEqual({ action: "keep", reason: "intervening-write" });
  });

  it("does not create a row when none was observed", () => {
    expect(
      decideLedgerSnapshot(
        null,
        { eventAt: SECOND, eventId: "evt_seed" },
        snapshot(),
        SNAPSHOT_BOUND,
      ),
    ).toEqual({ action: "keep", reason: "missing" });
  });

  it("does not regress snapshotAt when the incoming bound is older", () => {
    const current = record("acct", { snapshotAt: SNAPSHOT_BOUND });
    const decision = decideLedgerSnapshot(
      current,
      observeWatermark(current),
      snapshot(),
      SECOND,
    );
    expect(decision).toMatchObject({
      action: "write",
      value: { snapshotAt: SNAPSHOT_BOUND, eventId: "evt_seed" },
    });
  });

  it("re-evaluates sticky and firstWins against the freshly read row", () => {
    const current = {
      ...record("acct"),
      foundingMember: true,
      consentAt: EARLIER,
      consentVersion: "first",
    };
    const decision = decideLedgerSnapshot(
      current,
      observeWatermark(current),
      snapshot({
        fields: {
          foundingMember: false,
          consentAt: LATER,
          consentVersion: "second",
        },
      }),
      SNAPSHOT_BOUND,
      HOST_FIELDS,
    );
    expect(decision).toMatchObject({
      action: "write",
      value: {
        foundingMember: true,
        consentAt: EARLIER,
        consentVersion: "first",
        eventId: "evt_seed",
      },
    });
  });

  it("treats (eventAt, eventId) as the token, not a storage version", () => {
    const current = record("acct", { plan: "kept-identity" });
    expect(observeWatermark(current)).toEqual({
      eventAt: SECOND,
      eventId: "evt_seed",
    });
    expect(
      watermarksMatch(current, { eventAt: SECOND, eventId: "evt_seed" }),
    ).toBe(true);
    expect(
      watermarksMatch(current, { eventAt: SECOND, eventId: "evt_other" }),
    ).toBe(false);
    expect(DEFAULT_SWEEP_LIMIT).toBe(100);
  });
});

function snapshotReconciliation(name: string, freshStore: () => Store): void {
  describe(name, () => {
    it("delayed-intermediate-webhook-after-sweep", async () => {
      const clock = controllableClock(EARLIER);
      const store = freshStore();
      const ledger = createBillingLedger({ store, clock });
      await ledger.apply(
        "acct_delayed_after_sweep",
        event("evt_applied", { eventAt: EARLIER, status: "active" }),
      );

      clock.set(SNAPSHOT_BOUND);
      const swept = await ledger.reconcile(
        "acct_delayed_after_sweep",
        async (observed) => snapshot({ plan: observed.plan }),
      );
      expect(swept.written).toBe(true);
      expect(swept.record.snapshotAt).toBe(SNAPSHOT_BOUND);
      expect(swept.record.eventId).toBe("evt_applied");
      expect(swept.record.eventAt).toBe(EARLIER);

      const delayed = await ledger.apply(
        "acct_delayed_after_sweep",
        event("evt_delayed_intermediate", {
          eventAt: SECOND,
          status: "past_due",
          plan: "should-not-land",
        }),
      );
      expect(delayed.applied).toBe(false);
      expect(await ledger.get("acct_delayed_after_sweep")).toMatchObject({
        status: "active",
        eventId: "evt_applied",
        eventAt: EARLIER,
        snapshotAt: SNAPSHOT_BOUND,
        plan: "pro",
      });
    });

    it("intervening-write drops snapshot", async () => {
      const clock = controllableClock(SECOND);
      const store = freshStore();
      const ledger = createBillingLedger({ store, clock });
      await ledger.apply(
        "acct_intervening",
        event("evt_seed", { eventAt: EARLIER, plan: "original" }),
      );

      const result = await ledger.reconcile("acct_intervening", async () => {
        await ledger.apply(
          "acct_intervening",
          event("evt_newer", {
            eventAt: LATER,
            status: "canceled",
            plan: "from-event",
          }),
        );
        return snapshot({ plan: "from-stale-fetch", status: "active" });
      });
      expect(result).toMatchObject({
        written: false,
        reason: "intervening-write",
      });
      expect(await ledger.get("acct_intervening")).toMatchObject({
        status: "canceled",
        eventId: "evt_newer",
        eventAt: LATER,
        plan: "from-event",
        snapshotAt: null,
      });
    });

    it("no-op still advances snapshotAt", async () => {
      const clock = controllableClock(SECOND);
      const base = freshStore();
      const tracked = trackLedgerStorage(base);
      const ledger = createBillingLedger({ store: tracked.store, clock });
      await ledger.apply("acct_noop_sweep", event("evt_seed"));
      const before = await ledger.get("acct_noop_sweep");
      expect(before?.snapshotAt).toBeNull();
      const updatesAfterApply = tracked.calls.update;

      clock.set(SNAPSHOT_BOUND);
      const result = await ledger.reconcile(
        "acct_noop_sweep",
        async (observed) =>
          snapshot({
            status: observed.status,
            plan: observed.plan,
            providerCustomerId: observed.providerCustomerId,
            providerSubscriptionId: observed.providerSubscriptionId,
            providerPriceId: observed.providerPriceId,
            periodStartAt: observed.periodStartAt,
            periodEndAt: observed.periodEndAt,
            trialStartAt: observed.trialStartAt,
            trialEndAt: observed.trialEndAt,
            cancelAtPeriodEnd: observed.cancelAtPeriodEnd,
          }),
      );
      expect(result.written).toBe(true);
      expect(tracked.calls.update).toBeGreaterThan(updatesAfterApply);
      expect(result.record).toMatchObject({
        eventId: "evt_seed",
        eventAt: SECOND,
        snapshotAt: SNAPSHOT_BOUND,
        status: "active",
        plan: "pro",
      });
      expect(await ledger.get("acct_noop_sweep")).toEqual(result.record);
    });

    it("fetches provider truth only after observing the watermark", async () => {
      const clock = controllableClock(SECOND);
      const base = freshStore();
      const order: string[] = [];
      const ledger = createBillingLedger({
        store: {
          collection(definition) {
            const delegate = base.collection(definition);
            return {
              ...delegate,
              async get(key) {
                order.push("observe");
                return delegate.get(key);
              },
              async update(key, decide, updateOptions) {
                order.push("update");
                return delegate.update(key, decide, updateOptions);
              },
            };
          },
        },
        clock,
      });
      await ledger.apply("acct_observe_first", event("evt_seed"));
      order.length = 0;
      await ledger.reconcile("acct_observe_first", async (observed) => {
        order.push("fetch");
        expect(observed.eventId).toBe("evt_seed");
        expect(observed.eventAt).toBe(SECOND);
        return snapshot();
      });
      expect(order).toEqual(["observe", "fetch", "update"]);
    });

    it("sweep pages accounts and writes each observed row", async () => {
      const clock = controllableClock(SNAPSHOT_BOUND);
      const store = freshStore();
      const ledger = createBillingLedger({ store, clock });
      await ledger.apply("acct_sweep_a", event("evt_a", { plan: "a" }));
      await ledger.apply("acct_sweep_b", event("evt_b", { plan: "b" }));

      const first = await ledger.sweep(
        async (observed) => snapshot({ plan: observed.plan }),
        {
          limit: 1,
        },
      );
      expect(first.results).toHaveLength(1);
      expect(first.results[0]?.written).toBe(true);
      expect(first.nextCursor).not.toBeNull();

      const second = await ledger.sweep(
        async (observed) => snapshot({ plan: observed.plan }),
        first.nextCursor === null
          ? { limit: 1 }
          : { limit: 1, cursor: first.nextCursor },
      );
      expect(second.results).toHaveLength(1);
      expect(second.results[0]?.written).toBe(true);
      expect(second.nextCursor).toBeNull();

      expect(await ledger.get("acct_sweep_a")).toMatchObject({
        snapshotAt: SNAPSHOT_BOUND,
        eventId: "evt_a",
        plan: "a",
      });
      expect(await ledger.get("acct_sweep_b")).toMatchObject({
        snapshotAt: SNAPSHOT_BOUND,
        eventId: "evt_b",
        plan: "b",
      });
    });

    it("skips a missing account and a null provider fetch without writing", async () => {
      const clock = controllableClock(SNAPSHOT_BOUND);
      const base = freshStore();
      const tracked = trackLedgerStorage(base);
      const ledger = createBillingLedger({ store: tracked.store, clock });
      await ledger.apply("acct_present", event("evt_seed"));
      const updatesAfterApply = tracked.calls.update;

      expect(
        await ledger.reconcile("acct_missing", async () => snapshot()),
      ).toEqual({
        written: false,
        record: null,
        reason: "missing",
      });
      expect(
        await ledger.reconcile("acct_present", async () => null),
      ).toMatchObject({
        written: false,
        reason: "unavailable",
        record: { eventId: "evt_seed", snapshotAt: null },
      });
      expect(tracked.calls.update).toBe(updatesAfterApply);
    });

    it("logs snapshot outcomes without payload or amount fields", async () => {
      const entries: Array<{
        level: string;
        message: string;
        fields?: Readonly<Record<string, unknown>>;
      }> = [];
      const logger: Logger = {
        log(level, message, fields) {
          entries.push({
            level,
            message,
            ...(fields === undefined ? {} : { fields }),
          });
        },
      };
      const clock = controllableClock(SNAPSHOT_BOUND);
      const ledger = createBillingLedger({
        store: freshStore(),
        clock,
        logger,
      });
      await ledger.apply("acct_snap_log", event("evt_seed"));
      entries.length = 0;
      await ledger.reconcile("acct_snap_log", async () => snapshot());
      await ledger.reconcile("acct_snap_missing", async () => snapshot());

      expect(entries).toEqual([
        {
          level: "info",
          message: "Billing ledger snapshot written",
          fields: {
            accountId: "acct_snap_log",
            eventId: "evt_seed",
            written: true,
          },
        },
        {
          level: "info",
          message: "Billing ledger snapshot ignored",
          fields: {
            accountId: "acct_snap_missing",
            written: false,
          },
        },
      ]);
      expect(JSON.stringify(entries)).not.toContain("payload");
      expect(JSON.stringify(entries)).not.toContain("amount");
    });
  });
}

snapshotReconciliation("snapshot reconciliation / memory", createMemoryStore);
snapshotReconciliation(
  "snapshot reconciliation / Azure Tables",
  freshAzureStore,
);

describe("snapshot reconciliation clock discipline", () => {
  it("requires an injected clock and never uses Date.now for snapshotAt", async () => {
    const ledger = createBillingLedger({ store: createMemoryStore() });
    await expect(
      ledger.reconcile("acct_no_clock", async () => snapshot()),
    ).rejects.toThrow(/Clock/);
    await expect(ledger.sweep(async () => snapshot())).rejects.toThrow(/Clock/);
    expect(DEFAULT_SWEEP_LIMIT).toBe(100);
  });
});
