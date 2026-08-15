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
  billingLedgerCollection,
  billingLedgerKey,
  createBillingLedger,
  decideLedgerApplication,
  effectiveWatermarkSecond,
  LIFECYCLE_RANK,
  lifecycleRank,
  type LedgerEvent,
  type LedgerRecord,
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

function event(
  eventId: string,
  overrides: Partial<LedgerEvent> = {},
): LedgerEvent {
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
        record("acct_create", { eventId: "evt_first" }),
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
    });
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
