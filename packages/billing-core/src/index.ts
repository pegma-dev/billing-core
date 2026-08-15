import {
  noopLogger,
  type Clock,
  type IsoTimestamp,
  type Logger,
} from "@pegma/spine";
import {
  defineCollection,
  MAX_SCAN_PAGE_SIZE,
  type CollectionDefinition,
  type EntityKey,
  type Store,
  type StoredRecord,
  type StoredValue,
} from "@pegma/storage-core";

const SAFE_KEY_PART = /^[A-Za-z0-9|_.:@-]{1,256}$/;
const HOST_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CANONICAL_ISO_TIMESTAMP =
  /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LEDGER_ROW_ID = "subscription";

/** Default checkout-reservation lifetime. Abandoned checkouts expire. */
export const DEFAULT_RESERVATION_TTL_MS = 30 * 60 * 1000;
const MAX_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Default page size for a snapshot-reconciliation sweep. */
export const DEFAULT_SWEEP_LIMIT = 100;

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

/** Granting statuses are a live subscription for the reservation gate. */
export function isGrantingStatus(status: LifecycleStatus): boolean {
  return lifecycleRank(status) === LIFECYCLE_RANK.active;
}

function offerIsRedeemed(
  current: Pick<LedgerFields, "offerRedeemed" | "status"> | null,
  event: Pick<LedgerEvent, "offerRedeemed" | "status">,
): boolean {
  if (current?.offerRedeemed === true || event.offerRedeemed === true) {
    return true;
  }
  return (
    (current !== null && isGrantingStatus(current.status)) ||
    isGrantingStatus(event.status)
  );
}

/** Values a host-declared ledger field may persist. */
export type HostFieldValue = string | number | boolean | null;

/** Host-declared fields governed by {@link sticky} / {@link firstWins}. */
export type HostFields = object;

/** A boolean that only ever flips false → true. */
export interface StickyInvariant {
  readonly kind: "sticky";
}

/**
 * A field or named group whose first write is permanent.
 *
 * Fields that share a `group` freeze together: once any member is written,
 * later events cannot change any member of the group.
 */
export interface FirstWinsInvariant {
  readonly kind: "firstWins";
  readonly group?: string;
}

export type FieldInvariant = StickyInvariant | FirstWinsInvariant;

export type LedgerFieldMap = Record<string, FieldInvariant>;

export type HostFromInvariants<TFields extends LedgerFieldMap> = {
  [K in keyof TFields]: TFields[K] extends StickyInvariant
    ? boolean
    : HostFieldValue;
};

export type LedgerInvariants<THost extends HostFields> = {
  readonly [K in keyof THost]: FieldInvariant;
};

/** Declares a one-way boolean flag. */
export function sticky(): StickyInvariant {
  return { kind: "sticky" };
}

/** Declares a first-write-wins field, optionally as part of a named group. */
export function firstWins(group?: string): FirstWinsInvariant {
  return group === undefined
    ? { kind: "firstWins" }
    : { kind: "firstWins", group };
}

/**
 * One subscription ledger row per billing account.
 *
 * Provider identifiers and derived state only. The codec is the data
 * boundary: it will not persist card data, raw payloads, line items, or
 * amounts even if a caller casts them onto the value.
 */
export interface LedgerFields {
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
  readonly reservationId: string | null;
  readonly reservationExpiresAt: IsoTimestamp | null;
  readonly reservationSeeded: boolean;
  readonly offerRedeemed: boolean;
}

export type LedgerRecord<THost extends HostFields = {}> = LedgerFields & THost;

/** Provider event to apply through the watermark guard and lifecycle rank. */
export type LedgerEvent<THost extends HostFields = {}> = {
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
  readonly offerRedeemed?: boolean;
  readonly fields?: Partial<THost>;
};

/**
 * Domain CAS token for snapshot reconciliation: the `(eventAt, eventId)`
 * pair observed before the provider fetch. Not a storage version.
 */
export interface WatermarkToken {
  readonly eventAt: IsoTimestamp | null;
  readonly eventId: string | null;
}

/**
 * What a sweep observed before fetching provider truth: the watermark
 * identity plus the snapshot freshness bound already on the row.
 *
 * Another reconciliation that lands first changes `snapshotAt` without
 * touching the watermark. Re-checking this bound is what drops the
 * slower, stale fetch.
 */
export interface SnapshotObservation extends WatermarkToken {
  readonly snapshotAt: IsoTimestamp | null;
}

/**
 * Provider truth used to repair field drift. It does not carry a watermark;
 * applying it must not change `eventAt` or `eventId`.
 */
export type LedgerSnapshot<THost extends HostFields = {}> = {
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
  readonly offerRedeemed?: boolean;
  readonly fields?: Partial<THost>;
};

export type FetchLedgerSnapshot<THost extends HostFields = {}> = (
  observed: LedgerRecord<THost>,
) => Promise<LedgerSnapshot<THost> | null>;

export type IgnoreReason = "redelivery" | "stale" | "equal-rank";

export type ApplicationDecision<THost extends HostFields = {}> =
  | { readonly action: "write"; readonly value: LedgerRecord<THost> }
  | { readonly action: "keep"; readonly reason: IgnoreReason };

export interface ApplyResult<THost extends HostFields = {}> {
  readonly applied: boolean;
  readonly record: LedgerRecord<THost>;
}

export type ReserveRefusal = "redeemed" | "subscribed" | "reserved";

export type ReserveDecision<THost extends HostFields = {}> =
  | { readonly action: "write"; readonly value: LedgerRecord<THost> }
  | { readonly action: "keep"; readonly reason: ReserveRefusal };

export type ReserveResult =
  | {
      readonly reserved: true;
      readonly reservationId: string;
      readonly expiresAt: IsoTimestamp;
    }
  | { readonly reserved: false; readonly reason: ReserveRefusal };

export interface ReserveOptions {
  readonly ttlMs?: number;
}

export interface ReleaseResult {
  readonly released: boolean;
}

export type SnapshotIgnoreReason =
  "missing" | "unavailable" | "eventless" | "intervening-write" | "superseded";

export type SnapshotDecision<THost extends HostFields = {}> =
  | { readonly action: "write"; readonly value: LedgerRecord<THost> }
  | { readonly action: "keep"; readonly reason: SnapshotIgnoreReason };

export type ReconcileResult<THost extends HostFields = {}> =
  | { readonly written: true; readonly record: LedgerRecord<THost> }
  | {
      readonly written: false;
      readonly record: LedgerRecord<THost> | null;
      readonly reason: SnapshotIgnoreReason;
    };

export interface SweepOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SweepResult<THost extends HostFields = {}> {
  readonly results: readonly ReconcileResult<THost>[];
  readonly nextCursor: string | null;
}

export interface BillingLedger<THost extends HostFields = {}> {
  get(accountId: string): Promise<LedgerRecord<THost> | null>;
  apply(
    accountId: string,
    event: LedgerEvent<THost>,
  ): Promise<ApplyResult<THost>>;
  reserve(accountId: string, options?: ReserveOptions): Promise<ReserveResult>;
  release(accountId: string, reservationId: string): Promise<ReleaseResult>;
  reconcile(
    accountId: string,
    fetchSnapshot: FetchLedgerSnapshot<THost>,
  ): Promise<ReconcileResult<THost>>;
  sweep(
    fetchSnapshot: FetchLedgerSnapshot<THost>,
    options?: SweepOptions,
  ): Promise<SweepResult<THost>>;
}

export interface BillingLedgerOptions<TFields extends LedgerFieldMap = {}> {
  readonly store: Store;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly newId?: () => string;
  readonly fields?: TFields;
  readonly reservationTtlMs?: number;
}

const LIFECYCLE_STATUSES = new Set<string>(Object.keys(LIFECYCLE_RANK));

const CORE_FIELD_NAMES = new Set<string>([
  "accountId",
  "providerCustomerId",
  "providerSubscriptionId",
  "providerPriceId",
  "status",
  "plan",
  "periodStartAt",
  "periodEndAt",
  "trialStartAt",
  "trialEndAt",
  "cancelAtPeriodEnd",
  "eventAt",
  "eventId",
  "snapshotAt",
  "reservationId",
  "reservationExpiresAt",
  "reservationSeeded",
  "offerRedeemed",
]);

const FORBIDDEN_HOST_FIELD_NAMES = new Set([
  "amount",
  "amounts",
  "card",
  "cards",
  "carddata",
  "cardnumber",
  "card_data",
  "card_number",
  "payload",
  "payloads",
  "rawpayload",
  "raw_payload",
  "lineitem",
  "lineitems",
  "line_item",
  "line_items",
]);

function isForbiddenHostFieldName(name: string): boolean {
  return FORBIDDEN_HOST_FIELD_NAMES.has(name.toLowerCase());
}

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

function assertSafeReservationId(reservationId: string): string {
  if (typeof reservationId !== "string" || !SAFE_KEY_PART.test(reservationId)) {
    throw new TypeError(
      "Unsupported billing reservation id: expected 1-256 safe key characters.",
    );
  }
  return reservationId;
}

function assertHostFieldNames(fields: LedgerFieldMap | undefined): void {
  if (fields === undefined) {
    return;
  }
  for (const name of Object.keys(fields)) {
    if (isForbiddenHostFieldName(name)) {
      throw new TypeError(
        `Unsupported host ledger field ${JSON.stringify(name)}: the ledger does not persist card data, raw payloads, line items, or amounts.`,
      );
    }
    if (CORE_FIELD_NAMES.has(name) || !HOST_FIELD_NAME.test(name)) {
      throw new TypeError(
        `Unsupported host ledger field ${JSON.stringify(name)}: expected a non-core name matching [A-Za-z][A-Za-z0-9_]{0,63}.`,
      );
    }
  }
}

function hostFieldKeys<TFields extends LedgerFieldMap>(
  fields: TFields | undefined,
): readonly (keyof TFields & string)[] {
  return fields === undefined
    ? []
    : (Object.keys(fields) as (keyof TFields & string)[]);
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

function timestampSeconds(timestamp: IsoTimestamp): number | null {
  const milliseconds = canonicalTimestampMilliseconds(timestamp);
  if (milliseconds === null) {
    return null;
  }
  return Math.floor(milliseconds / 1000);
}

function maxSecond(
  left: IsoTimestamp | null,
  right: IsoTimestamp | null,
): number | null {
  const leftSecond = left === null ? null : timestampSeconds(left);
  const rightSecond = right === null ? null : timestampSeconds(right);
  if (leftSecond === null) {
    return rightSecond;
  }
  if (rightSecond === null) {
    return leftSecond;
  }
  return leftSecond >= rightSecond ? leftSecond : rightSecond;
}

/**
 * Effective watermark second: `max(eventAt, snapshotAt)` as a Unix second.
 * Arrival time is not an input. Unparseable fields do not contribute.
 */
export function effectiveWatermarkSecond(
  record: Pick<LedgerFields, "eventAt" | "snapshotAt">,
): number | null {
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

function storedHostValue(value: unknown): StoredValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function isWrittenHostValue(value: HostFieldValue | undefined): boolean {
  return value !== undefined && value !== null;
}

function assertTtlMs(ttlMs: number): number {
  if (
    typeof ttlMs !== "number" ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_RESERVATION_TTL_MS
  ) {
    throw new TypeError(
      "Unsupported reservation TTL: expected a positive duration of at most 24 hours.",
    );
  }
  return ttlMs;
}

function assertClockNow(clock: Clock): IsoTimestamp {
  const now = clock.now();
  timestampMilliseconds(now, "billing clock");
  return now as IsoTimestamp;
}

function addMilliseconds(timestamp: IsoTimestamp, ms: number): IsoTimestamp {
  return new Date(
    timestampMilliseconds(timestamp, "billing clock") + ms,
  ).toISOString() as IsoTimestamp;
}

function defaultNewId(): string {
  const cryptoApi = (
    globalThis as unknown as {
      crypto?: { randomUUID?: () => string };
    }
  ).crypto;
  if (cryptoApi?.randomUUID === undefined) {
    throw new Error(
      "Billing reservation requires crypto.randomUUID or an injected newId.",
    );
  }
  return cryptoApi.randomUUID();
}

function requireClock(clock: Clock | undefined, purpose: string): Clock {
  if (clock === undefined) {
    throw new TypeError(`${purpose} requires an injected Clock.`);
  }
  return clock;
}

function assertSweepLimit(limit: number): number {
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_SCAN_PAGE_SIZE
  ) {
    throw new TypeError(
      `Unsupported sweep page size: expected an integer from 1 through ${MAX_SCAN_PAGE_SIZE}.`,
    );
  }
  return limit;
}

function laterTimestamp(
  left: IsoTimestamp | null,
  right: IsoTimestamp,
): IsoTimestamp {
  if (left === null) {
    return right;
  }
  const leftMs = canonicalTimestampMilliseconds(left);
  const rightMs = canonicalTimestampMilliseconds(right);
  if (leftMs === null) {
    return right;
  }
  if (rightMs === null) {
    return left;
  }
  return leftMs >= rightMs ? left : right;
}

/** Reads the domain CAS token from a ledger row. */
export function observeWatermark(
  record: Pick<LedgerFields, "eventAt" | "eventId">,
): WatermarkToken {
  return { eventAt: record.eventAt, eventId: record.eventId };
}

/** Reads the watermark and the snapshot freshness bound already on the row. */
export function observeSnapshot(
  record: Pick<LedgerFields, "eventAt" | "eventId" | "snapshotAt">,
): SnapshotObservation {
  return {
    eventAt: record.eventAt,
    eventId: record.eventId,
    snapshotAt: record.snapshotAt,
  };
}

export function watermarksMatch(
  current: Pick<LedgerFields, "eventAt" | "eventId">,
  observed: WatermarkToken,
): boolean {
  return (
    current.eventAt === observed.eventAt && current.eventId === observed.eventId
  );
}

export function hasEventWatermark(
  record: Pick<LedgerFields, "eventAt" | "eventId">,
): boolean {
  return record.eventAt !== null && record.eventId !== null;
}

function assertEvent<THost extends HostFields>(
  event: LedgerEvent<THost>,
): LedgerEvent<THost> {
  assertSafeEventId(event.eventId);
  timestampMilliseconds(event.eventAt, "billing event timestamp");
  const fields = event.fields;
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
    ...(event.offerRedeemed === true ? { offerRedeemed: true } : {}),
    ...(fields === undefined ? {} : { fields }),
  };
}

function assertSnapshot<THost extends HostFields>(
  snapshot: LedgerSnapshot<THost>,
): LedgerSnapshot<THost> {
  const fields = snapshot.fields;
  return {
    status: assertLifecycleStatus(snapshot.status),
    providerCustomerId: assertNullableString(
      snapshot.providerCustomerId,
      "provider customer id",
    ),
    providerSubscriptionId: assertNullableString(
      snapshot.providerSubscriptionId,
      "provider subscription id",
    ),
    providerPriceId: assertNullableString(
      snapshot.providerPriceId,
      "provider price id",
    ),
    plan: assertNullableString(snapshot.plan, "plan"),
    periodStartAt: optionalTimestamp(snapshot.periodStartAt, "period start"),
    periodEndAt: optionalTimestamp(snapshot.periodEndAt, "period end"),
    trialStartAt: optionalTimestamp(snapshot.trialStartAt, "trial start"),
    trialEndAt: optionalTimestamp(snapshot.trialEndAt, "trial end"),
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd === true,
    ...(snapshot.offerRedeemed === true ? { offerRedeemed: true } : {}),
    ...(fields === undefined ? {} : { fields }),
  };
}

function blankHostFields<TFields extends LedgerFieldMap>(
  invariants: TFields | undefined,
): HostFromInvariants<TFields> {
  const blank = {} as HostFromInvariants<TFields>;
  if (invariants === undefined) {
    return blank;
  }
  for (const key of hostFieldKeys(invariants)) {
    const invariant = invariants[key];
    if (invariant === undefined) {
      continue;
    }
    (blank as Record<string, HostFieldValue>)[key] =
      invariant.kind === "sticky" ? false : null;
  }
  return blank;
}

function blankLedgerRecord<TFields extends LedgerFieldMap>(
  accountId: string,
  invariants: TFields | undefined,
): LedgerRecord<HostFromInvariants<TFields>> {
  return {
    accountId,
    providerCustomerId: null,
    providerSubscriptionId: null,
    providerPriceId: null,
    status: "incomplete",
    plan: null,
    periodStartAt: null,
    periodEndAt: null,
    trialStartAt: null,
    trialEndAt: null,
    cancelAtPeriodEnd: false,
    eventAt: null,
    eventId: null,
    snapshotAt: null,
    reservationId: null,
    reservationExpiresAt: null,
    reservationSeeded: false,
    offerRedeemed: false,
    ...blankHostFields(invariants),
  };
}

/**
 * A row created only to hold a reservation has no event watermark yet.
 * The first provider event must still apply; a corrupt row that already
 * carries subscription state without a watermark must not.
 */
export function hasReservationProvenance(
  record: Pick<
    LedgerFields,
    "reservationId" | "reservationExpiresAt" | "reservationSeeded"
  >,
): boolean {
  return (
    record.reservationSeeded === true ||
    record.reservationId != null ||
    record.reservationExpiresAt != null
  );
}

export function isEventlessLedgerRow(
  record: Pick<
    LedgerFields,
    | "eventAt"
    | "eventId"
    | "snapshotAt"
    | "status"
    | "providerCustomerId"
    | "providerSubscriptionId"
    | "providerPriceId"
    | "plan"
    | "periodStartAt"
    | "periodEndAt"
    | "trialStartAt"
    | "trialEndAt"
    | "cancelAtPeriodEnd"
    | "reservationId"
    | "reservationExpiresAt"
    | "reservationSeeded"
  >,
): boolean {
  return (
    hasReservationProvenance(record) &&
    record.eventAt === null &&
    record.eventId === null &&
    record.snapshotAt === null &&
    record.status === "incomplete" &&
    record.providerCustomerId === null &&
    record.providerSubscriptionId === null &&
    record.providerPriceId === null &&
    record.plan === null &&
    record.periodStartAt === null &&
    record.periodEndAt === null &&
    record.trialStartAt === null &&
    record.trialEndAt === null &&
    record.cancelAtPeriodEnd === false
  );
}

function hostValueFromCurrent(
  current: object | null,
  key: string,
  invariant: FieldInvariant,
): HostFieldValue {
  if (current === null) {
    return invariant.kind === "sticky" ? false : null;
  }
  return storedHostValue((current as Record<string, unknown>)[key]);
}

/**
 * Enforces declared invariants against freshly read state.
 *
 * `sticky` keeps a true flag. `firstWins` keeps the first write of a field
 * or named group. Call this inside a decider so conflict retries re-evaluate.
 */
export function applyLedgerInvariants<THost extends HostFields>(
  current: LedgerRecord<THost> | null,
  incoming: Partial<THost> | undefined,
  invariants: LedgerInvariants<THost> | undefined,
): THost {
  const next = blankHostFields(invariants) as THost;
  if (invariants === undefined) {
    return next;
  }

  const incomingFields = incoming as Record<string, HostFieldValue> | undefined;
  const groupKeys = new Map<string, string[]>();
  for (const key of hostFieldKeys(invariants)) {
    const invariant = invariants[key];
    if (invariant === undefined) {
      continue;
    }
    if (invariant.kind === "sticky") {
      const already = hostValueFromCurrent(current, key, invariant) === true;
      const incomingValue = incomingFields?.[key];
      (next as Record<string, HostFieldValue>)[key] =
        already || incomingValue === true ? true : false;
      continue;
    }
    const group = invariant.group ?? key;
    const members = groupKeys.get(group) ?? [];
    members.push(key);
    groupKeys.set(group, members);
  }

  for (const members of groupKeys.values()) {
    const alreadyWritten = members.some((key) =>
      isWrittenHostValue(
        hostValueFromCurrent(current, key, { kind: "firstWins" }),
      ),
    );
    for (const key of members) {
      if (alreadyWritten) {
        (next as Record<string, HostFieldValue>)[key] = hostValueFromCurrent(
          current,
          key,
          { kind: "firstWins" },
        );
        continue;
      }
      const incomingValue = incomingFields?.[key];
      (next as Record<string, HostFieldValue>)[key] =
        incomingValue === undefined
          ? hostValueFromCurrent(current, key, { kind: "firstWins" })
          : storedHostValue(incomingValue);
    }
  }

  return next;
}

function projectAppliedRecord<THost extends HostFields>(
  current: LedgerRecord<THost> | null,
  accountId: string,
  event: LedgerEvent<THost>,
  invariants: LedgerInvariants<THost> | undefined,
): LedgerRecord<THost> {
  const granting = isGrantingStatus(event.status);
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
    snapshotAt: current?.snapshotAt ?? null,
    reservationId: granting ? null : (current?.reservationId ?? null),
    reservationExpiresAt: granting
      ? null
      : (current?.reservationExpiresAt ?? null),
    reservationSeeded: current?.reservationSeeded === true,
    offerRedeemed: offerIsRedeemed(current, event),
    ...applyLedgerInvariants(current, event.fields, invariants),
  } as LedgerRecord<THost>;
}

/**
 * Decides whether an event may replace the current ledger row.
 *
 * The incoming event applies when there is no row, when the row exists only
 * to hold a reservation, when its second is strictly newer than
 * `max(eventAt, snapshotAt)`, or when it shares that second and outranks the
 * stored status. Exact redelivery (same event id) is a keep. Equal rank at
 * the equal second drops the later arrival. An existing row with no usable
 * watermark that already carries subscription state is untrusted: keep,
 * never apply because the event arrived.
 *
 * Host-declared `sticky` / `firstWins` fields are enforced on the write
 * against the freshly read row.
 */
export function decideLedgerApplication<THost extends HostFields = {}>(
  current: LedgerRecord<THost> | null,
  accountId: string,
  event: LedgerEvent<THost>,
  invariants?: LedgerInvariants<THost>,
): ApplicationDecision<THost> {
  if (current === null || isEventlessLedgerRow(current)) {
    return {
      action: "write",
      value: projectAppliedRecord(current, accountId, event, invariants),
    };
  }
  if (current.eventId === event.eventId) {
    return { action: "keep", reason: "redelivery" };
  }

  const watermark = effectiveWatermarkSecond(current);
  const incoming = timestampSeconds(event.eventAt);
  if (watermark === null || incoming === null) {
    return { action: "keep", reason: "stale" };
  }
  if (incoming < watermark) {
    return { action: "keep", reason: "stale" };
  }
  if (incoming === watermark) {
    if (lifecycleRank(event.status) <= lifecycleRank(current.status)) {
      return { action: "keep", reason: "equal-rank" };
    }
  }

  return {
    action: "write",
    value: projectAppliedRecord(current, accountId, event, invariants),
  };
}

/**
 * A reservation is live when it has an id and an unexpired deadline.
 * Unparseable deadlines do not lock the account.
 */
export function reservationIsLive(
  record: Pick<LedgerFields, "reservationId" | "reservationExpiresAt">,
  now: IsoTimestamp,
): boolean {
  if (record.reservationId == null) {
    return false;
  }
  const expires = canonicalTimestampMilliseconds(record.reservationExpiresAt);
  const nowMs = canonicalTimestampMilliseconds(now);
  if (expires === null || nowMs === null) {
    return false;
  }
  return nowMs < expires;
}

/**
 * Mints or refuses a checkout reservation against freshly read state.
 *
 * `reservationId` is a candidate for this decider run only. The caller must
 * read the winning id back from the stored record after the write.
 */
export function decideReservation<THost extends HostFields = {}>(
  current: LedgerRecord<THost> | null,
  accountId: string,
  now: IsoTimestamp,
  reservationId: string,
  expiresAt: IsoTimestamp,
  invariants?: LedgerInvariants<THost>,
): ReserveDecision<THost> {
  const base =
    current === null
      ? (blankLedgerRecord(accountId, invariants) as LedgerRecord<THost>)
      : current;
  if (base.offerRedeemed) {
    return { action: "keep", reason: "redeemed" };
  }
  if (isGrantingStatus(base.status)) {
    return { action: "keep", reason: "subscribed" };
  }
  if (reservationIsLive(base, now)) {
    return { action: "keep", reason: "reserved" };
  }
  return {
    action: "write",
    value: {
      ...base,
      accountId,
      reservationId,
      reservationExpiresAt: expiresAt,
      reservationSeeded: true,
    },
  };
}

function projectSnapshotRecord<THost extends HostFields>(
  current: LedgerRecord<THost>,
  snapshot: LedgerSnapshot<THost>,
  snapshotAt: IsoTimestamp,
  invariants: LedgerInvariants<THost> | undefined,
): LedgerRecord<THost> {
  const granting = isGrantingStatus(snapshot.status);
  return {
    accountId: current.accountId,
    providerCustomerId: snapshot.providerCustomerId,
    providerSubscriptionId: snapshot.providerSubscriptionId,
    providerPriceId: snapshot.providerPriceId,
    status: snapshot.status,
    plan: snapshot.plan,
    periodStartAt: snapshot.periodStartAt,
    periodEndAt: snapshot.periodEndAt,
    trialStartAt: snapshot.trialStartAt,
    trialEndAt: snapshot.trialEndAt,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    eventAt: current.eventAt,
    eventId: current.eventId,
    snapshotAt: laterTimestamp(current.snapshotAt, snapshotAt),
    reservationId: granting ? null : (current.reservationId ?? null),
    reservationExpiresAt: granting
      ? null
      : (current.reservationExpiresAt ?? null),
    reservationSeeded: current.reservationSeeded === true,
    offerRedeemed: offerIsRedeemed(current, snapshot),
    ...applyLedgerInvariants(current, snapshot.fields, invariants),
  } as LedgerRecord<THost>;
}

/**
 * Decides whether a provider snapshot may repair the current ledger row.
 *
 * The host must observe {@link SnapshotObservation} first, sample the
 * freshness bound, then fetch provider truth, then call this against
 * freshly read state. A watermark mismatch means an intervening event
 * landed; a `snapshotAt` mismatch means another reconciliation already
 * wrote. Either drops the snapshot. A reservation-only / eventless row
 * has no event identity to repair — refuse a `(null, null)` match so a
 * founding webhook is not gated by an invented bound.
 *
 * A match ALWAYS writes — even when no field changed — so `snapshotAt`
 * advances and a delayed intermediate webhook cannot land after a no-op
 * sweep. `eventAt` and `eventId` are copied from current state and never
 * replaced.
 *
 * Host-declared `sticky` / `firstWins` fields are enforced on the write
 * against the freshly read row.
 */
export function decideLedgerSnapshot<THost extends HostFields = {}>(
  current: LedgerRecord<THost> | null,
  observed: SnapshotObservation,
  snapshot: LedgerSnapshot<THost>,
  snapshotAt: IsoTimestamp,
  invariants?: LedgerInvariants<THost>,
): SnapshotDecision<THost> {
  if (current === null) {
    return { action: "keep", reason: "missing" };
  }
  if (isEventlessLedgerRow(current) || !hasEventWatermark(current)) {
    return { action: "keep", reason: "eventless" };
  }
  if (!watermarksMatch(current, observed)) {
    return { action: "keep", reason: "intervening-write" };
  }
  if (current.snapshotAt !== observed.snapshotAt) {
    return { action: "keep", reason: "superseded" };
  }
  return {
    action: "write",
    value: projectSnapshotRecord(current, snapshot, snapshotAt, invariants),
  };
}

type EncodedLedgerRecord<THost extends HostFields> = Record<
  keyof LedgerFields | keyof THost,
  StoredValue
>;

function encodeLedgerCore(
  value: LedgerFields,
): Record<keyof LedgerFields, StoredValue> {
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
    reservationId: value.reservationId,
    reservationExpiresAt: value.reservationExpiresAt,
    reservationSeeded: value.reservationSeeded,
    offerRedeemed: value.offerRedeemed,
  } satisfies Record<keyof LedgerFields, StoredValue>;
}

function encodeLedgerRecord<THost extends HostFields>(
  value: LedgerRecord<THost>,
  hostKeys: readonly (keyof THost & string)[],
): EncodedLedgerRecord<THost> {
  const encoded = encodeLedgerCore(value) as EncodedLedgerRecord<THost>;
  for (const key of hostKeys) {
    if (isForbiddenHostFieldName(key)) {
      continue;
    }
    encoded[key] = storedHostValue((value as Record<string, unknown>)[key]);
  }
  return encoded;
}

function decodeLedgerRecord<THost extends HostFields>(
  record: StoredRecord,
  hostKeys: readonly (keyof THost & string)[],
  invariants: LedgerInvariants<THost> | undefined,
): LedgerRecord<THost> {
  const host = blankHostFields(invariants);
  for (const key of hostKeys) {
    const invariant = invariants?.[key];
    const raw = record[key];
    (host as Record<string, HostFieldValue>)[key] =
      invariant?.kind === "sticky" ? raw === true : storedHostValue(raw);
  }
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
    reservationId: toNullableString(record["reservationId"]),
    reservationExpiresAt: storedTimestamp(record["reservationExpiresAt"]),
    reservationSeeded: record["reservationSeeded"] === true,
    offerRedeemed: record["offerRedeemed"] === true,
    ...host,
  } as LedgerRecord<THost>;
}

export function billingLedgerKey(accountId: string): EntityKey {
  return {
    partition: assertSafeAccountId(accountId),
    id: LEDGER_ROW_ID,
  };
}

export function billingLedgerCollection<TFields extends LedgerFieldMap = {}>(
  fields?: TFields,
): CollectionDefinition<LedgerRecord<HostFromInvariants<TFields>>> {
  type THost = HostFromInvariants<TFields>;
  const invariants = fields as LedgerInvariants<THost> | undefined;
  assertHostFieldNames(invariants);
  const hostKeys = hostFieldKeys(invariants) as readonly (keyof THost &
    string)[];
  return defineCollection({
    name: "billingLedger",
    key: (value) => billingLedgerKey(value.accountId),
    codec: {
      encode: (value) => encodeLedgerRecord<THost>(value, hostKeys),
      decode: (record) =>
        decodeLedgerRecord<THost>(record, hostKeys, invariants),
    },
  });
}

export function createBillingLedger<TFields extends LedgerFieldMap = {}>(
  options: BillingLedgerOptions<TFields>,
): BillingLedger<HostFromInvariants<TFields>> {
  type THost = HostFromInvariants<TFields>;
  const logger = options.logger ?? noopLogger;
  const newId = options.newId ?? defaultNewId;
  const invariants = options.fields as LedgerInvariants<THost> | undefined;
  assertHostFieldNames(invariants);
  const defaultTtlMs = assertTtlMs(
    options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS,
  );
  const definition = billingLedgerCollection(options.fields);
  const rows = options.store.collection(definition);

  async function reconcileAccount(
    accountId: string,
    fetchSnapshot: FetchLedgerSnapshot<THost>,
  ): Promise<ReconcileResult<THost>> {
    assertSafeAccountId(accountId);
    const clock = requireClock(
      options.clock,
      "Billing snapshot reconciliation",
    );
    const observed = await rows.get(billingLedgerKey(accountId));
    if (observed === null) {
      logger.log("info", "Billing ledger snapshot ignored", {
        accountId,
        written: false,
      });
      return { written: false, record: null, reason: "missing" };
    }
    if (isEventlessLedgerRow(observed) || !hasEventWatermark(observed)) {
      logger.log("info", "Billing ledger snapshot ignored", {
        accountId,
        eventId: observed.eventId,
        written: false,
      });
      return { written: false, record: observed, reason: "eventless" };
    }
    const token = observeSnapshot(observed);
    const snapshotAt = assertClockNow(clock);
    const fetched = await fetchSnapshot(observed);
    if (fetched === null) {
      logger.log("info", "Billing ledger snapshot ignored", {
        accountId,
        eventId: token.eventId,
        written: false,
      });
      return { written: false, record: observed, reason: "unavailable" };
    }
    const snapshot = assertSnapshot(fetched);
    let ignore: SnapshotIgnoreReason | undefined;
    const result = await rows.update(billingLedgerKey(accountId), (current) => {
      const decision = decideLedgerSnapshot(
        current,
        token,
        snapshot,
        snapshotAt,
        invariants,
      );
      if (decision.action === "keep") {
        ignore = decision.reason;
        return { action: "keep" as const };
      }
      return decision;
    });
    const written = result.written;
    logger.log(
      "info",
      written
        ? "Billing ledger snapshot written"
        : "Billing ledger snapshot ignored",
      {
        accountId,
        eventId: token.eventId,
        written,
      },
    );
    if (written) {
      if (result.value === null) {
        throw new Error(
          "Billing ledger snapshot write did not persist a record.",
        );
      }
      return { written: true, record: result.value };
    }
    return {
      written: false,
      record: result.value,
      reason: ignore ?? "intervening-write",
    };
  }

  return {
    async get(accountId) {
      return rows.get(billingLedgerKey(accountId));
    },

    async apply(accountId, event) {
      assertSafeAccountId(accountId);
      const incoming = assertEvent(event);
      const result = await rows.update(billingLedgerKey(accountId), (current) =>
        decideLedgerApplication(current, accountId, incoming, invariants),
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

    async reserve(accountId, reserveOptions) {
      assertSafeAccountId(accountId);
      const clock = requireClock(options.clock, "Billing reservation");
      const ttlMs = assertTtlMs(reserveOptions?.ttlMs ?? defaultTtlMs);
      let refusal: ReserveRefusal | undefined;
      const result = await rows.update(
        billingLedgerKey(accountId),
        (current) => {
          const now = assertClockNow(clock);
          const candidateId = assertSafeReservationId(newId());
          const decision = decideReservation(
            current,
            accountId,
            now,
            candidateId,
            addMilliseconds(now, ttlMs),
            invariants,
          );
          if (decision.action === "keep") {
            refusal = decision.reason;
            return { action: "keep" as const };
          }
          return decision;
        },
      );
      if (result.written) {
        const stored = result.value;
        if (
          stored === null ||
          stored.reservationId === null ||
          stored.reservationExpiresAt === null
        ) {
          throw new Error(
            "Billing reservation write did not persist a reservation.",
          );
        }
        logger.log("info", "Billing reservation minted", {
          accountId,
          reserved: true,
        });
        return {
          reserved: true,
          reservationId: stored.reservationId,
          expiresAt: stored.reservationExpiresAt,
        };
      }
      const reason = refusal ?? "reserved";
      logger.log("info", "Billing reservation refused", {
        accountId,
        reserved: false,
        reason,
      });
      return { reserved: false, reason };
    },

    async release(accountId, reservationId) {
      assertSafeAccountId(accountId);
      assertSafeReservationId(reservationId);
      const result = await rows.update(
        billingLedgerKey(accountId),
        (current) => {
          if (current === null || current.reservationId !== reservationId) {
            return { action: "keep" as const };
          }
          return {
            action: "write" as const,
            value: {
              ...current,
              reservationId: null,
              reservationExpiresAt: null,
            },
          };
        },
      );
      const released = result.written;
      logger.log("info", "Billing reservation released", {
        accountId,
        released,
      });
      return { released };
    },

    async reconcile(accountId, fetchSnapshot) {
      return reconcileAccount(accountId, fetchSnapshot);
    },

    async sweep(fetchSnapshot, sweepOptions) {
      requireClock(options.clock, "Billing snapshot reconciliation");
      const limit = assertSweepLimit(
        sweepOptions?.limit ?? DEFAULT_SWEEP_LIMIT,
      );
      const page = await rows.scan({
        limit,
        ...(sweepOptions?.cursor === undefined
          ? {}
          : { cursor: sweepOptions.cursor }),
      });
      const results: ReconcileResult<THost>[] = [];
      for (const scanned of page.records) {
        results.push(
          await reconcileAccount(scanned.key.partition, fetchSnapshot),
        );
      }
      return { results, nextCursor: page.nextCursor };
    },
  };
}
