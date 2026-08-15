import {
  noopLogger,
  type Clock,
  type IsoTimestamp,
  type Logger,
} from "@pegma/spine";
import {
  defineCollection,
  type CollectionDefinition,
  type EntityKey,
  type Store,
  type StoredRecord,
  type StoredValue,
} from "@pegma/storage-core";

const SAFE_KEY_PART = /^[A-Za-z0-9|_.:@-]{1,256}$/;
const CANONICAL_ISO_TIMESTAMP =
  /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LEDGER_ROW_ID = "subscription";

/**
 * Provider-agnostic subscription lifecycle.
 *
 * Granting states (`trialing`, `active`, `past_due`) outrank the transient
 * `incomplete`. Terminal non-granting states (`unpaid`, `canceled`) outrank
 * granting ones. Equal rank at the equal second drops the later arrival.
 */
export type LifecycleStatus =
  "incomplete" | "trialing" | "active" | "past_due" | "unpaid" | "canceled";

export const LIFECYCLE_RANK = {
  incomplete: 0,
  trialing: 1,
  active: 1,
  past_due: 1,
  unpaid: 2,
  canceled: 2,
} as const satisfies Record<LifecycleStatus, number>;

export function lifecycleRank(status: LifecycleStatus): number {
  return LIFECYCLE_RANK[status];
}

/**
 * One subscription ledger row per billing account.
 *
 * Provider identifiers and derived state only. The codec is the data
 * boundary: it will not persist card data, raw payloads, line items, or
 * amounts even if a caller casts them onto the value.
 */
export interface LedgerRecord {
  readonly accountId: string;
  readonly providerCustomerId: string | null;
  readonly providerSubscriptionId: string | null;
  readonly providerPriceId: string | null;
  readonly status: LifecycleStatus;
  readonly plan: string | null;
  readonly periodStartAt: IsoTimestamp | null;
  readonly periodEndAt: IsoTimestamp | null;
  readonly trialStartAt: IsoTimestamp | null;
  readonly trialEndAt: IsoTimestamp | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly eventAt: IsoTimestamp | null;
  readonly eventId: string | null;
  readonly snapshotAt: IsoTimestamp | null;
}

/** Provider event to apply through the watermark guard and lifecycle rank. */
export interface LedgerEvent {
  readonly eventId: string;
  readonly eventAt: IsoTimestamp;
  readonly status: LifecycleStatus;
  readonly providerCustomerId: string | null;
  readonly providerSubscriptionId: string | null;
  readonly providerPriceId: string | null;
  readonly plan: string | null;
  readonly periodStartAt: IsoTimestamp | null;
  readonly periodEndAt: IsoTimestamp | null;
  readonly trialStartAt: IsoTimestamp | null;
  readonly trialEndAt: IsoTimestamp | null;
  readonly cancelAtPeriodEnd: boolean;
}

export type IgnoreReason = "redelivery" | "stale" | "equal-rank";

export type ApplicationDecision =
  | { readonly action: "write"; readonly value: LedgerRecord }
  | { readonly action: "keep"; readonly reason: IgnoreReason };

export interface ApplyResult {
  readonly applied: boolean;
  readonly record: LedgerRecord;
}

export interface BillingLedger {
  get(accountId: string): Promise<LedgerRecord | null>;
  apply(accountId: string, event: LedgerEvent): Promise<ApplyResult>;
}

export interface BillingLedgerOptions {
  readonly store: Store;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

const LIFECYCLE_STATUSES = new Set<string>(Object.keys(LIFECYCLE_RANK));

function assertSafeAccountId(accountId: string): string {
  if (typeof accountId !== "string" || !SAFE_KEY_PART.test(accountId)) {
    throw new TypeError(
      "Unsupported billing account id: expected 1-256 safe key characters.",
    );
  }
  return accountId;
}

function assertSafeEventId(eventId: string): string {
  if (typeof eventId !== "string" || !SAFE_KEY_PART.test(eventId)) {
    throw new TypeError(
      "Unsupported billing event id: expected 1-256 safe key characters.",
    );
  }
  return eventId;
}

function canonicalTimestampMilliseconds(timestamp: unknown): number | null {
  if (
    typeof timestamp !== "string" ||
    !CANONICAL_ISO_TIMESTAMP.test(timestamp)
  ) {
    return null;
  }
  const milliseconds = Date.parse(timestamp);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== timestamp
  ) {
    return null;
  }
  return milliseconds;
}

function timestampMilliseconds(timestamp: unknown, label: string): number {
  const milliseconds = canonicalTimestampMilliseconds(timestamp);
  if (milliseconds === null) {
    throw new TypeError(
      `Invalid ${label}: expected a canonical UTC ISO timestamp with milliseconds.`,
    );
  }
  return milliseconds;
}

function optionalTimestamp(
  timestamp: unknown,
  label: string,
): IsoTimestamp | null {
  if (timestamp == null) {
    return null;
  }
  timestampMilliseconds(timestamp, label);
  return timestamp as IsoTimestamp;
}

function storedTimestamp(value: unknown): IsoTimestamp | null {
  return canonicalTimestampMilliseconds(value) === null
    ? null
    : (value as IsoTimestamp);
}

function secondKey(timestamp: IsoTimestamp): string {
  return timestamp.slice(0, 19);
}

function maxSecond(
  left: IsoTimestamp | null,
  right: IsoTimestamp | null,
): string | null {
  if (left === null) {
    return right === null ? null : secondKey(right);
  }
  if (right === null) {
    return secondKey(left);
  }
  const leftSecond = secondKey(left);
  const rightSecond = secondKey(right);
  return leftSecond >= rightSecond ? leftSecond : rightSecond;
}

/**
 * Effective watermark second: `max(eventAt, snapshotAt)` at second
 * resolution. Arrival time is not an input.
 */
export function effectiveWatermarkSecond(
  record: Pick<LedgerRecord, "eventAt" | "snapshotAt">,
): string | null {
  return maxSecond(record.eventAt, record.snapshotAt);
}

function toStatus(value: unknown): LifecycleStatus {
  return typeof value === "string" && LIFECYCLE_STATUSES.has(value)
    ? (value as LifecycleStatus)
    : "incomplete";
}

function toNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function assertLifecycleStatus(status: unknown): LifecycleStatus {
  if (typeof status !== "string" || !LIFECYCLE_STATUSES.has(status)) {
    throw new TypeError(
      "Unsupported billing lifecycle status: expected a known ledger status.",
    );
  }
  return status as LifecycleStatus;
}

function assertNullableString(value: unknown, label: string): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`Invalid ${label}: expected a string or null.`);
  }
  return value;
}

function assertEvent(event: LedgerEvent): LedgerEvent {
  assertSafeEventId(event.eventId);
  timestampMilliseconds(event.eventAt, "billing event timestamp");
  return {
    eventId: event.eventId,
    eventAt: event.eventAt,
    status: assertLifecycleStatus(event.status),
    providerCustomerId: assertNullableString(
      event.providerCustomerId,
      "provider customer id",
    ),
    providerSubscriptionId: assertNullableString(
      event.providerSubscriptionId,
      "provider subscription id",
    ),
    providerPriceId: assertNullableString(
      event.providerPriceId,
      "provider price id",
    ),
    plan: assertNullableString(event.plan, "plan"),
    periodStartAt: optionalTimestamp(event.periodStartAt, "period start"),
    periodEndAt: optionalTimestamp(event.periodEndAt, "period end"),
    trialStartAt: optionalTimestamp(event.trialStartAt, "trial start"),
    trialEndAt: optionalTimestamp(event.trialEndAt, "trial end"),
    cancelAtPeriodEnd: event.cancelAtPeriodEnd === true,
  };
}

function recordFromEvent(
  accountId: string,
  event: LedgerEvent,
  snapshotAt: IsoTimestamp | null,
): LedgerRecord {
  return {
    accountId,
    providerCustomerId: event.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId,
    providerPriceId: event.providerPriceId,
    status: event.status,
    plan: event.plan,
    periodStartAt: event.periodStartAt,
    periodEndAt: event.periodEndAt,
    trialStartAt: event.trialStartAt,
    trialEndAt: event.trialEndAt,
    cancelAtPeriodEnd: event.cancelAtPeriodEnd,
    eventAt: event.eventAt,
    eventId: event.eventId,
    snapshotAt,
  };
}

/**
 * Decides whether an event may replace the current ledger row.
 *
 * The incoming event applies when there is no row, when its second is
 * strictly newer than `max(eventAt, snapshotAt)`, or when it shares that
 * second and outranks the stored status. Exact redelivery (same event id)
 * is a keep. Equal rank at the equal second drops the later arrival.
 */
export function decideLedgerApplication(
  current: LedgerRecord | null,
  accountId: string,
  event: LedgerEvent,
): ApplicationDecision {
  if (current === null) {
    return {
      action: "write",
      value: recordFromEvent(accountId, event, null),
    };
  }
  if (current.eventId === event.eventId) {
    return { action: "keep", reason: "redelivery" };
  }

  const watermark = effectiveWatermarkSecond(current);
  const incoming = secondKey(event.eventAt);
  if (watermark !== null && incoming < watermark) {
    return { action: "keep", reason: "stale" };
  }
  if (watermark !== null && incoming === watermark) {
    if (lifecycleRank(event.status) <= lifecycleRank(current.status)) {
      return { action: "keep", reason: "equal-rank" };
    }
  }

  return {
    action: "write",
    value: recordFromEvent(accountId, event, current.snapshotAt),
  };
}

type EncodedLedgerRecord = Record<keyof LedgerRecord, StoredValue>;

function encodeLedgerRecord(value: LedgerRecord): EncodedLedgerRecord {
  return {
    accountId: value.accountId,
    providerCustomerId: value.providerCustomerId,
    providerSubscriptionId: value.providerSubscriptionId,
    providerPriceId: value.providerPriceId,
    status: value.status,
    plan: value.plan,
    periodStartAt: value.periodStartAt,
    periodEndAt: value.periodEndAt,
    trialStartAt: value.trialStartAt,
    trialEndAt: value.trialEndAt,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd,
    eventAt: value.eventAt,
    eventId: value.eventId,
    snapshotAt: value.snapshotAt,
  };
}

function decodeLedgerRecord(record: StoredRecord): LedgerRecord {
  return {
    accountId: String(record["accountId"] ?? ""),
    providerCustomerId: toNullableString(record["providerCustomerId"]),
    providerSubscriptionId: toNullableString(record["providerSubscriptionId"]),
    providerPriceId: toNullableString(record["providerPriceId"]),
    status: toStatus(record["status"]),
    plan: toNullableString(record["plan"]),
    periodStartAt: storedTimestamp(record["periodStartAt"]),
    periodEndAt: storedTimestamp(record["periodEndAt"]),
    trialStartAt: storedTimestamp(record["trialStartAt"]),
    trialEndAt: storedTimestamp(record["trialEndAt"]),
    cancelAtPeriodEnd: record["cancelAtPeriodEnd"] === true,
    eventAt: storedTimestamp(record["eventAt"]),
    eventId: toNullableString(record["eventId"]),
    snapshotAt: storedTimestamp(record["snapshotAt"]),
  };
}

export function billingLedgerKey(accountId: string): EntityKey {
  return {
    partition: assertSafeAccountId(accountId),
    id: LEDGER_ROW_ID,
  };
}

export function billingLedgerCollection(): CollectionDefinition<LedgerRecord> {
  return defineCollection({
    name: "billingLedger",
    key: (value) => billingLedgerKey(value.accountId),
    codec: {
      encode: encodeLedgerRecord,
      decode: decodeLedgerRecord,
    },
  });
}

export function createBillingLedger(
  options: BillingLedgerOptions,
): BillingLedger {
  const logger = options.logger ?? noopLogger;
  const definition = billingLedgerCollection();
  const rows = options.store.collection(definition);

  return {
    async get(accountId) {
      return rows.get(billingLedgerKey(accountId));
    },

    async apply(accountId, event) {
      assertSafeAccountId(accountId);
      const incoming = assertEvent(event);
      const result = await rows.update(billingLedgerKey(accountId), (current) =>
        decideLedgerApplication(current, accountId, incoming),
      );
      if (result.value === null) {
        throw new Error("Billing ledger apply did not persist a record.");
      }
      const applied = result.written;
      logger.log(
        "info",
        applied
          ? "Billing ledger event applied"
          : "Billing ledger event ignored",
        {
          accountId,
          eventId: incoming.eventId,
          applied,
        },
      );
      return { applied, record: result.value };
    },
  };
}
