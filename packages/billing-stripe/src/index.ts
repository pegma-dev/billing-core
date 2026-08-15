import { noopLogger, type IsoTimestamp, type Logger } from "@pegma/spine";
import type {
  FetchLedgerSnapshot,
  HostFields,
  LedgerEvent,
  LedgerRecord,
  LedgerSnapshot,
  LifecycleStatus,
} from "@pegma/billing-core";

/**
 * Stripe subscription statuses that exist on both sides of the adapter.
 * Extra Stripe statuses map onto the nearest ledger status by grant and
 * terminal-ness — never by arrival order.
 *
 * `incomplete_expired` is a finished first-invoice failure → `canceled`.
 * `paused` is non-granting and still live → `unpaid` (same rank as
 * `canceled`, so a same-second `active` cannot resurrect it).
 */
export const STRIPE_LIFECYCLE_STATUS = {
  incomplete: "incomplete",
  incomplete_expired: "canceled",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  unpaid: "unpaid",
  paused: "unpaid",
} as const satisfies Record<string, LifecycleStatus>;

export type StripeLifecycleStatus = keyof typeof STRIPE_LIFECYCLE_STATUS;

/** Host mapping from a Stripe Price id to the ledger `plan` field. */
export type PlanFromPrice = (priceId: string) => string | null;

export interface StripeTranslateOptions {
  readonly planFromPrice?: PlanFromPrice;
}

/**
 * Narrow retrieve port. The host's Stripe SDK stays behind this function —
 * this package never imports `stripe` and never verifies signatures.
 */
export interface StripeSubscriptionClient {
  retrieveSubscription(subscriptionId: string): Promise<unknown>;
}

export interface StripeSnapshotFetcherOptions extends StripeTranslateOptions {
  readonly client: StripeSubscriptionClient;
  readonly logger?: Logger;
}

export interface StripeBillingAdapter<THost extends HostFields = {}> {
  translateEvent(event: unknown): LedgerEvent<THost> | null;
  fetchSnapshot: FetchLedgerSnapshot<THost>;
}

const STRIPE_STATUS_NAMES = new Set<string>(
  Object.keys(STRIPE_LIFECYCLE_STATUS),
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idFrom(value: unknown, objectName?: string): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (!isPlainRecord(value)) {
    return null;
  }
  if (
    objectName !== undefined &&
    value["object"] !== undefined &&
    value["object"] !== objectName
  ) {
    return null;
  }
  const id = value["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

function unixSecondsToIso(value: unknown): IsoTimestamp | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const milliseconds = Math.trunc(value) * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    return null;
  }
  return new Date(milliseconds).toISOString() as IsoTimestamp;
}

function firstItem(
  subscription: Record<string, unknown>,
): Record<string, unknown> | null {
  const items = subscription["items"];
  if (!isPlainRecord(items)) {
    return null;
  }
  const data = items["data"];
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  const first = data[0];
  return isPlainRecord(first) ? first : null;
}

function priceFromSubscription(
  subscription: Record<string, unknown>,
): Record<string, unknown> | string | null {
  const item = firstItem(subscription);
  if (item === null) {
    const legacy = subscription["plan"];
    return isPlainRecord(legacy) || typeof legacy === "string" ? legacy : null;
  }
  const price = item["price"];
  if (isPlainRecord(price) || typeof price === "string") {
    return price;
  }
  const plan = item["plan"];
  return isPlainRecord(plan) || typeof plan === "string" ? plan : null;
}

function priceIdFromSubscription(
  subscription: Record<string, unknown>,
): string | null {
  return idFrom(priceFromSubscription(subscription), "price");
}

function lookupKeyFromPrice(
  price: Record<string, unknown> | string | null,
): string | null {
  if (!isPlainRecord(price)) {
    return null;
  }
  const lookupKey = price["lookup_key"];
  return typeof lookupKey === "string" && lookupKey.length > 0
    ? lookupKey
    : null;
}

function periodUnix(
  subscription: Record<string, unknown>,
  field: "current_period_start" | "current_period_end",
): unknown {
  const top = subscription[field];
  if (top != null) {
    return top;
  }
  const item = firstItem(subscription);
  return item?.[field];
}

function defaultPlan(
  subscription: Record<string, unknown>,
  planFromPrice: PlanFromPrice | undefined,
): string | null {
  const priceId = priceIdFromSubscription(subscription);
  if (planFromPrice !== undefined && priceId !== null) {
    const mapped = planFromPrice(priceId);
    return mapped == null ? null : String(mapped);
  }
  return lookupKeyFromPrice(priceFromSubscription(subscription));
}

/**
 * Maps a Stripe subscription status onto {@link LifecycleStatus}.
 * Unknown names return null — the adapter does not invent a grant.
 */
export function translateStripeLifecycleStatus(
  status: unknown,
): LifecycleStatus | null {
  if (typeof status !== "string" || !STRIPE_STATUS_NAMES.has(status)) {
    return null;
  }
  return STRIPE_LIFECYCLE_STATUS[status as StripeLifecycleStatus];
}

function subscriptionRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  if (value["object"] === "subscription") {
    return value;
  }
  // A present discriminator that is not "subscription" is never a
  // Subscription — PaymentIntent, Checkout Session, Invoice, and similar
  // all carry their own id + status.
  if (value["object"] !== undefined) {
    return null;
  }
  // Structural fallback only when Stripe omitted the discriminator, and
  // only for a subscription-shaped id. A bare `pi_…` / `cs_…` / `in_…`
  // with a lifecycle-like status must not become providerSubscriptionId.
  const id = idFrom(value);
  if (
    id !== null &&
    id.startsWith("sub_") &&
    typeof value["status"] === "string"
  ) {
    return value;
  }
  return null;
}

/**
 * Pulls an expanded Subscription out of a verified Stripe object.
 *
 * Accepts a Subscription (`object === "subscription"`), a Checkout
 * Session whose `subscription` is expanded, or an Invoice whose
 * `subscription` (or `parent.subscription_details.subscription`) is
 * expanded. Wrappers are never themselves a Subscription, even when they
 * have an id and a status. A bare id is not enough to write derived
 * state — the host should snapshot-fetch.
 */
export function stripeSubscriptionFromObject(
  value: unknown,
): Record<string, unknown> | null {
  const direct = subscriptionRecord(value);
  if (direct !== null) {
    return direct;
  }
  if (!isPlainRecord(value)) {
    return null;
  }
  const nested = value["subscription"];
  const fromNested = subscriptionRecord(nested);
  if (fromNested !== null) {
    return fromNested;
  }
  const parent = value["parent"];
  if (isPlainRecord(parent)) {
    const details = parent["subscription_details"];
    if (isPlainRecord(details)) {
      const fromParent = subscriptionRecord(details["subscription"]);
      if (fromParent !== null) {
        return fromParent;
      }
    }
  }
  return null;
}

function translateSubscriptionFields(
  subscription: Record<string, unknown>,
  options: StripeTranslateOptions | undefined,
): Omit<LedgerSnapshot, "offerRedeemed" | "fields"> | null {
  const status = translateStripeLifecycleStatus(subscription["status"]);
  if (status === null) {
    return null;
  }
  const providerSubscriptionId = idFrom(subscription);
  if (providerSubscriptionId === null) {
    return null;
  }
  return {
    status,
    providerCustomerId: idFrom(subscription["customer"], "customer"),
    providerSubscriptionId,
    providerPriceId: priceIdFromSubscription(subscription),
    plan: defaultPlan(subscription, options?.planFromPrice),
    periodStartAt: unixSecondsToIso(
      periodUnix(subscription, "current_period_start"),
    ),
    periodEndAt: unixSecondsToIso(
      periodUnix(subscription, "current_period_end"),
    ),
    trialStartAt: unixSecondsToIso(subscription["trial_start"]),
    trialEndAt: unixSecondsToIso(subscription["trial_end"]),
    cancelAtPeriodEnd: subscription["cancel_at_period_end"] === true,
  };
}

/**
 * Translates a Stripe Subscription (or an object that embeds one) into
 * ledger snapshot fields. Identifiers and derived state only.
 */
export function translateStripeSubscription<THost extends HostFields = {}>(
  subscription: unknown,
  options?: StripeTranslateOptions,
): LedgerSnapshot<THost> | null {
  const record = stripeSubscriptionFromObject(subscription);
  if (record === null) {
    return null;
  }
  return translateSubscriptionFields(record, options) as LedgerSnapshot<THost>;
}

function eventEnvelope(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  if (value["object"] === "event") {
    return value;
  }
  if (typeof value["id"] === "string" && typeof value["type"] === "string") {
    return value;
  }
  return null;
}

function eventDataObject(event: Record<string, unknown>): unknown {
  const data = event["data"];
  if (!isPlainRecord(data)) {
    return undefined;
  }
  return data["object"];
}

/**
 * Translates a verified Stripe Event into a {@link LedgerEvent}.
 *
 * The host verifies the signature and supplies the parsed event. This
 * function never inspects a signing secret. Events that do not carry an
 * expanded subscription, or whose status has no ledger mapping, return
 * null so the host can ignore them without applying invented state.
 */
export function translateStripeEvent<THost extends HostFields = {}>(
  event: unknown,
  options?: StripeTranslateOptions,
): LedgerEvent<THost> | null {
  const envelope = eventEnvelope(event);
  if (envelope === null) {
    return null;
  }
  const eventId = envelope["id"];
  if (typeof eventId !== "string" || eventId.length === 0) {
    return null;
  }
  const eventAt = unixSecondsToIso(envelope["created"]);
  if (eventAt === null) {
    return null;
  }
  const fields = translateStripeSubscription<THost>(
    eventDataObject(envelope),
    options,
  );
  if (fields === null) {
    return null;
  }
  return {
    eventId,
    eventAt,
    ...fields,
  };
}

/**
 * Builds a {@link FetchLedgerSnapshot} that retrieves the observed
 * subscription through the injected client and translates it.
 *
 * A missing subscription id, a retrieve that returns null, or an
 * untranslatable object yields null (`unavailable`). Retrieve errors
 * propagate so a sweep can fail closed.
 */
export function createStripeSnapshotFetcher<THost extends HostFields = {}>(
  options: StripeSnapshotFetcherOptions,
): FetchLedgerSnapshot<THost> {
  const retrieve = options.client.retrieveSubscription;
  if (typeof retrieve !== "function") {
    throw new TypeError(
      "Stripe snapshot fetch requires client.retrieveSubscription.",
    );
  }
  const logger = options.logger ?? noopLogger;
  const translateOptions: StripeTranslateOptions = {
    ...(options.planFromPrice === undefined
      ? {}
      : { planFromPrice: options.planFromPrice }),
  };

  return async (observed: LedgerRecord<THost>) => {
    const subscriptionId = observed.providerSubscriptionId;
    if (subscriptionId === null || subscriptionId.length === 0) {
      logger.log("info", "Billing Stripe snapshot ignored", {
        accountId: observed.accountId,
        translated: false,
      });
      return null;
    }
    const retrieved = await retrieve.call(options.client, subscriptionId);
    const snapshot = translateStripeSubscription<THost>(
      retrieved,
      translateOptions,
    );
    logger.log(
      "info",
      snapshot === null
        ? "Billing Stripe snapshot ignored"
        : "Billing Stripe snapshot translated",
      {
        accountId: observed.accountId,
        translated: snapshot !== null,
      },
    );
    return snapshot;
  };
}

/**
 * Bundles event translation and snapshot fetch behind one injected client.
 * Signature verification and account-id binding stay with the host.
 */
export function createStripeBillingAdapter<THost extends HostFields = {}>(
  options: StripeSnapshotFetcherOptions,
): StripeBillingAdapter<THost> {
  const translateOptions: StripeTranslateOptions = {
    ...(options.planFromPrice === undefined
      ? {}
      : { planFromPrice: options.planFromPrice }),
  };
  return {
    translateEvent: (event) =>
      translateStripeEvent<THost>(event, translateOptions),
    fetchSnapshot: createStripeSnapshotFetcher<THost>(options),
  };
}
