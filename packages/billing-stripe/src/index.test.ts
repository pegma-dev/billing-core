import {
  createBillingLedger,
  decideLedgerApplication,
  type ApplicationDecision,
  type LedgerRecord,
} from "@pegma/billing-core";
import { createMemoryStore } from "@pegma/storage-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createStripeBillingAdapter,
  createStripeSnapshotFetcher,
  STRIPE_LIFECYCLE_STATUS,
  stripeSubscriptionFromObject,
  translateStripeEvent,
  translateStripeLifecycleStatus,
  translateStripeSubscription,
} from "./index.js";

const SECOND = 1_723_737_600;
const SECOND_ISO = "2024-08-15T16:00:00.000Z";
const PERIOD_START = 1_722_513_600;
const PERIOD_END = 1_725_192_000;
const PERIOD_START_ISO = "2024-08-01T12:00:00.000Z";
const PERIOD_END_ISO = "2024-09-01T12:00:00.000Z";
const TRIAL_START = 1_722_427_200;
const TRIAL_END = 1_723_737_600;

function stripeSubscription(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "sub_123",
    object: "subscription",
    customer: "cus_123",
    status: "active",
    cancel_at_period_end: false,
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    trial_start: null,
    trial_end: null,
    items: {
      object: "list",
      data: [
        {
          id: "si_123",
          object: "subscription_item",
          price: {
            id: "price_pro",
            object: "price",
            lookup_key: "pro",
            unit_amount: 9900,
          },
        },
      ],
    },
    latest_invoice: {
      id: "in_secret",
      amount_paid: 9900,
      lines: { data: [{ amount: 9900, description: "Pro" }] },
    },
    default_payment_method: {
      id: "pm_card",
      card: { last4: "4242", brand: "visa" },
    },
    ...overrides,
  };
}

function stripeEvent(
  type: string,
  object: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "evt_123",
    object: "event",
    type,
    created: SECOND,
    data: { object },
    ...overrides,
  };
}

function expectedSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    status: "active",
    providerCustomerId: "cus_123",
    providerSubscriptionId: "sub_123",
    providerPriceId: "price_pro",
    plan: "pro",
    periodStartAt: PERIOD_START_ISO,
    periodEndAt: PERIOD_END_ISO,
    trialStartAt: null,
    trialEndAt: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function assertNoForbiddenFields(value: object): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/4242|unit_amount|amount_paid|last4|visa/u);
  expect(value).not.toHaveProperty("amount");
  expect(value).not.toHaveProperty("card");
  expect(value).not.toHaveProperty("payload");
  expect(value).not.toHaveProperty("line_items");
  expect(value).not.toHaveProperty("latest_invoice");
  expect(value).not.toHaveProperty("default_payment_method");
}

describe("translateStripeLifecycleStatus", () => {
  it("maps Stripe statuses onto ledger statuses", () => {
    expect(translateStripeLifecycleStatus("incomplete")).toBe("incomplete");
    expect(translateStripeLifecycleStatus("incomplete_expired")).toBe(
      "canceled",
    );
    expect(translateStripeLifecycleStatus("trialing")).toBe("trialing");
    expect(translateStripeLifecycleStatus("active")).toBe("active");
    expect(translateStripeLifecycleStatus("past_due")).toBe("past_due");
    expect(translateStripeLifecycleStatus("canceled")).toBe("canceled");
    expect(translateStripeLifecycleStatus("unpaid")).toBe("unpaid");
    expect(translateStripeLifecycleStatus("paused")).toBe("unpaid");
  });

  it("refuses unknown or non-string statuses instead of inventing a grant", () => {
    expect(translateStripeLifecycleStatus("paused_pending")).toBeNull();
    expect(translateStripeLifecycleStatus("active ")).toBeNull();
    expect(translateStripeLifecycleStatus(null)).toBeNull();
    expect(translateStripeLifecycleStatus(1)).toBeNull();
  });

  it("keeps the published mapping table aligned with the translator", () => {
    for (const [stripe, ledger] of Object.entries(STRIPE_LIFECYCLE_STATUS)) {
      expect(translateStripeLifecycleStatus(stripe)).toBe(ledger);
    }
  });
});

describe("translateStripeSubscription", () => {
  it("copies identifiers and derived state only", () => {
    const snapshot = translateStripeSubscription(stripeSubscription());
    expect(snapshot).toEqual(expectedSnapshot());
    assertNoForbiddenFields(snapshot!);
  });

  it("reads an expanded customer and a price id string", () => {
    const snapshot = translateStripeSubscription(
      stripeSubscription({
        customer: { id: "cus_expanded", object: "customer", email: "a@b.c" },
        items: {
          data: [{ price: "price_string" }],
        },
      }),
    );
    expect(snapshot).toMatchObject({
      providerCustomerId: "cus_expanded",
      providerPriceId: "price_string",
      plan: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain("a@b.c");
  });

  it("reads period bounds from the first subscription item when the top-level fields are absent", () => {
    const snapshot = translateStripeSubscription(
      stripeSubscription({
        current_period_start: undefined,
        current_period_end: undefined,
        items: {
          data: [
            {
              current_period_start: PERIOD_START,
              current_period_end: PERIOD_END,
              price: { id: "price_pro", lookup_key: "pro" },
            },
          ],
        },
      }),
    );
    expect(snapshot).toMatchObject({
      periodStartAt: PERIOD_START_ISO,
      periodEndAt: PERIOD_END_ISO,
    });
  });

  it("translates trial bounds and cancel-at-period-end", () => {
    const snapshot = translateStripeSubscription(
      stripeSubscription({
        status: "trialing",
        trial_start: TRIAL_START,
        trial_end: TRIAL_END,
        cancel_at_period_end: true,
      }),
    );
    expect(snapshot).toMatchObject({
      status: "trialing",
      trialStartAt: "2024-07-31T12:00:00.000Z",
      trialEndAt: SECOND_ISO,
      cancelAtPeriodEnd: true,
    });
  });

  it("lets the host map a price id to a plan name", () => {
    const snapshot = translateStripeSubscription(stripeSubscription(), {
      planFromPrice: (priceId) => (priceId === "price_pro" ? "founding" : null),
    });
    expect(snapshot?.plan).toBe("founding");
  });

  it("returns null for a bare subscription id or an unknown status", () => {
    expect(translateStripeSubscription("sub_123")).toBeNull();
    expect(
      translateStripeSubscription(stripeSubscription({ status: "mystery" })),
    ).toBeNull();
    expect(translateStripeSubscription({ object: "customer" })).toBeNull();
  });

  it("extracts an expanded subscription from a Checkout Session and an Invoice", () => {
    const subscription = stripeSubscription({ status: "trialing" });
    expect(
      translateStripeSubscription({
        object: "checkout.session",
        mode: "subscription",
        subscription,
        amount_total: 9900,
      }),
    ).toMatchObject({ status: "trialing", providerSubscriptionId: "sub_123" });
    expect(
      translateStripeSubscription({
        object: "invoice",
        subscription,
        amount_paid: 9900,
      }),
    ).toMatchObject({ status: "trialing" });
    expect(
      translateStripeSubscription({
        object: "invoice",
        parent: { subscription_details: { subscription } },
      }),
    ).toMatchObject({ status: "trialing" });
    expect(
      stripeSubscriptionFromObject({
        object: "checkout.session",
        subscription: "sub_123",
      }),
    ).toBeNull();
  });
});

describe("translateStripeEvent", () => {
  it("uses the event id and created second as the watermark", () => {
    const event = translateStripeEvent(
      stripeEvent("customer.subscription.updated", stripeSubscription()),
    );
    expect(event).toEqual({
      eventId: "evt_123",
      eventAt: SECOND_ISO,
      ...expectedSnapshot(),
    });
    assertNoForbiddenFields(event!);
  });

  it("translates each subscription event type", () => {
    for (const type of [
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "customer.subscription.paused",
      "customer.subscription.resumed",
      "customer.subscription.pending_update_applied",
      "customer.subscription.pending_update_expired",
    ]) {
      const status =
        type === "customer.subscription.deleted"
          ? "canceled"
          : type === "customer.subscription.paused"
            ? "paused"
            : "active";
      const event = translateStripeEvent(
        stripeEvent(type, stripeSubscription({ status })),
      );
      expect(event?.eventId).toBe("evt_123");
      expect(event?.status).toBe(STRIPE_LIFECYCLE_STATUS[status]);
    }
  });

  it("translates checkout.session.completed when the subscription is expanded", () => {
    const event = translateStripeEvent(
      stripeEvent("checkout.session.completed", {
        object: "checkout.session",
        mode: "subscription",
        customer: "cus_123",
        subscription: stripeSubscription({ status: "active" }),
        amount_total: 9900,
      }),
    );
    expect(event).toMatchObject({
      eventId: "evt_123",
      eventAt: SECOND_ISO,
      status: "active",
      providerSubscriptionId: "sub_123",
    });
    assertNoForbiddenFields(event!);
  });

  it("ignores events that do not carry an expanded subscription", () => {
    expect(
      translateStripeEvent(
        stripeEvent("checkout.session.completed", {
          object: "checkout.session",
          mode: "subscription",
          subscription: "sub_123",
        }),
      ),
    ).toBeNull();
    expect(
      translateStripeEvent(
        stripeEvent("charge.succeeded", {
          object: "charge",
          amount: 9900,
          payment_method_details: { card: { last4: "4242" } },
        }),
      ),
    ).toBeNull();
    expect(translateStripeEvent({ object: "event", type: "ping" })).toBeNull();
    expect(translateStripeEvent(stripeSubscription())).toBeNull();
  });
});

describe("same-second rank through translated Stripe events", () => {
  it("keeps canceled over active in both arrival orders", () => {
    const canceled = translateStripeEvent(
      stripeEvent(
        "customer.subscription.deleted",
        stripeSubscription({ status: "canceled" }),
        { id: "evt_canceled" },
      ),
    );
    const active = translateStripeEvent(
      stripeEvent(
        "customer.subscription.updated",
        stripeSubscription({ status: "active" }),
        { id: "evt_active" },
      ),
    );
    expect(canceled?.eventAt).toBe(active?.eventAt);
    expect(canceled?.status).toBe("canceled");
    expect(active?.status).toBe("active");

    for (const [accountId, order] of [
      ["acct_canceled_first", [canceled!, active!]],
      ["acct_active_first", [active!, canceled!]],
    ] as const) {
      let current: LedgerRecord | null = null;
      for (const incoming of order) {
        const decision: ApplicationDecision = decideLedgerApplication(
          current,
          accountId,
          incoming,
        );
        if (decision.action === "write") {
          current = decision.value;
        }
      }
      expect(current).toMatchObject({
        status: "canceled",
        eventId: "evt_canceled",
        eventAt: SECOND_ISO,
      });
    }
  });

  it("applies the same canceled-over-active outcome through the ledger", async () => {
    const canceled = translateStripeEvent(
      stripeEvent(
        "customer.subscription.deleted",
        stripeSubscription({ status: "canceled" }),
        { id: "evt_canceled" },
      ),
    )!;
    const active = translateStripeEvent(
      stripeEvent(
        "customer.subscription.updated",
        stripeSubscription({ status: "active" }),
        { id: "evt_active" },
      ),
    )!;

    for (const [accountId, order] of [
      ["acct_apply_canceled_first", [canceled, active]],
      ["acct_apply_active_first", [active, canceled]],
    ] as const) {
      const ledger = createBillingLedger({ store: createMemoryStore() });
      for (const incoming of order) {
        await ledger.apply(accountId, incoming);
      }
      expect(await ledger.get(accountId)).toMatchObject({
        status: "canceled",
        eventId: "evt_canceled",
      });
    }
  });

  it("lets a same-second paused Stripe status outrank active", () => {
    const paused = translateStripeEvent(
      stripeEvent(
        "customer.subscription.paused",
        stripeSubscription({ status: "paused" }),
        { id: "evt_paused" },
      ),
    )!;
    const active = translateStripeEvent(
      stripeEvent(
        "customer.subscription.updated",
        stripeSubscription({ status: "active" }),
        { id: "evt_active" },
      ),
    )!;
    expect(paused.status).toBe("unpaid");

    const afterActive = decideLedgerApplication(null, "acct_pause", active);
    expect(afterActive.action).toBe("write");
    const afterPaused = decideLedgerApplication(
      afterActive.action === "write" ? afterActive.value : null,
      "acct_pause",
      paused,
    );
    expect(afterPaused).toMatchObject({
      action: "write",
      value: { status: "unpaid", eventId: "evt_paused" },
    });
  });
});

describe("createStripeSnapshotFetcher", () => {
  const observed = {
    accountId: "acct_snap",
    providerCustomerId: "cus_123",
    providerSubscriptionId: "sub_123",
    providerPriceId: "price_stale",
    status: "active" as const,
    plan: "stale",
    periodStartAt: PERIOD_START_ISO,
    periodEndAt: PERIOD_END_ISO,
    trialStartAt: null,
    trialEndAt: null,
    cancelAtPeriodEnd: false,
    eventAt: SECOND_ISO,
    eventId: "evt_seed",
    snapshotAt: null,
    snapshotGeneration: 0,
    reservationId: null,
    reservationExpiresAt: null,
    reservationSeeded: false,
    offerRedeemed: true,
  };

  it("retrieves the observed subscription and translates provider truth", async () => {
    const retrieved: unknown[] = [];
    const fetchSnapshot = createStripeSnapshotFetcher({
      client: {
        async retrieveSubscription(id) {
          retrieved.push(id);
          return stripeSubscription({
            status: "past_due",
            cancel_at_period_end: true,
            items: {
              data: [{ price: { id: "price_pro", lookup_key: "pro" } }],
            },
          });
        },
      },
    });

    const snapshot = await fetchSnapshot(observed);
    expect(retrieved).toEqual(["sub_123"]);
    expect(snapshot).toEqual(
      expectedSnapshot({
        status: "past_due",
        cancelAtPeriodEnd: true,
      }),
    );
    assertNoForbiddenFields(snapshot!);
  });

  it("returns null when the row has no subscription id or retrieve yields nothing translatable", async () => {
    const fetchSnapshot = createStripeSnapshotFetcher({
      client: {
        retrieveSubscription: async () => null,
      },
    });
    expect(
      await fetchSnapshot({ ...observed, providerSubscriptionId: null }),
    ).toBeNull();
    expect(await fetchSnapshot(observed)).toBeNull();
  });

  it("propagates retrieve failures so a sweep can fail closed", async () => {
    const fetchSnapshot = createStripeSnapshotFetcher({
      client: {
        retrieveSubscription: async () => {
          throw new Error("stripe unavailable");
        },
      },
    });
    await expect(fetchSnapshot(observed)).rejects.toThrow("stripe unavailable");
  });

  it("repairs drift through ledger.reconcile", async () => {
    const store = createMemoryStore();
    const ledger = createBillingLedger({
      store,
      clock: { now: () => "2024-08-15T16:05:00.000Z" },
    });
    const applied = translateStripeEvent(
      stripeEvent("customer.subscription.created", stripeSubscription()),
    )!;
    await ledger.apply("acct_repair", applied);

    const fetchSnapshot = createStripeSnapshotFetcher({
      client: {
        retrieveSubscription: async () =>
          stripeSubscription({
            status: "past_due",
            items: {
              data: [{ price: { id: "price_pro", lookup_key: "pro" } }],
            },
          }),
      },
    });
    const result = await ledger.reconcile("acct_repair", fetchSnapshot);
    expect(result.written).toBe(true);
    if (result.written) {
      expect(result.record).toMatchObject({
        status: "past_due",
        eventId: "evt_123",
        eventAt: SECOND_ISO,
        plan: "pro",
      });
    }
  });

  it("logs account id and translation outcome, never payloads", async () => {
    const lines: Array<{ message: string; extra: unknown }> = [];
    const fetchSnapshot = createStripeSnapshotFetcher({
      logger: {
        log(level, message, extra) {
          expect(level).toBe("info");
          lines.push({ message, extra });
        },
      },
      client: {
        retrieveSubscription: async () => stripeSubscription(),
      },
    });
    await fetchSnapshot(observed);
    expect(lines).toEqual([
      {
        message: "Billing Stripe snapshot translated",
        extra: { accountId: "acct_snap", translated: true },
      },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/4242|unit_amount|payload/u);
  });
});

describe("createStripeBillingAdapter", () => {
  it("exposes event translation and snapshot fetch behind the injected client", async () => {
    const adapter = createStripeBillingAdapter({
      client: {
        retrieveSubscription: async () =>
          stripeSubscription({ status: "canceled" }),
      },
    });
    const event = adapter.translateEvent(
      stripeEvent("customer.subscription.updated", stripeSubscription()),
    );
    expect(event?.status).toBe("active");
    const snapshot = await adapter.fetchSnapshot({
      accountId: "acct_adapter",
      providerCustomerId: "cus_123",
      providerSubscriptionId: "sub_123",
      providerPriceId: "price_pro",
      status: "active",
      plan: "pro",
      periodStartAt: PERIOD_START_ISO,
      periodEndAt: PERIOD_END_ISO,
      trialStartAt: null,
      trialEndAt: null,
      cancelAtPeriodEnd: false,
      eventAt: SECOND_ISO,
      eventId: "evt_seed",
      snapshotAt: null,
      snapshotGeneration: 0,
      reservationId: null,
      reservationExpiresAt: null,
      reservationSeeded: false,
      offerRedeemed: true,
    });
    expect(snapshot?.status).toBe("canceled");
  });

  it("rejects a client without retrieveSubscription", () => {
    expect(() =>
      createStripeSnapshotFetcher({
        client: {} as { retrieveSubscription: () => Promise<unknown> },
      }),
    ).toThrow(/retrieveSubscription/u);
  });
});

describe("package contract", () => {
  it("does not call Date.now or verify signatures on the production path", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).not.toMatch(/Date\.now\s*\(/u);
    expect(source).not.toMatch(/constructEvent|stripe-signature/u);
    expect(source).not.toMatch(/from ["']stripe["']/u);
  });
});
