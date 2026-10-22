import type { StockKey } from "@ahb/data";

export interface Profile {
  id: string;
  name: string;
  createdAt: string;
}

export interface RestaurantRecord {
  id: string;
  ownerId: string;
  name: string;
  balanceCents: number;
  stock: Record<StockKey, number>;
  upgrades: string[];
  /** Incremented on every durable change; used for optimistic concurrency and exports. */
  version: number;
  createdAt: string;
}

/** Exclusive write lease for one live room (spec §14: one writer per restaurant). */
export interface Lease {
  restaurantId: string;
  holder: string;
  /** Fencing token: increases every time the lease changes hands. */
  epoch: number;
}

export interface SaleInput {
  lease: Lease;
  shiftId: string;
  orderNumber: number;
  /** Unique idempotency key for the order, e.g. `${shiftId}:${orderNumber}`. */
  orderKey: string;
  priceCents: number;
  tipCents: number;
  score: number;
  feedback: string[];
  /** Items handed to the customer; removed again if a checkpoint restore still contains them. */
  servedItemIds: string[];
}

export interface SaleRecord {
  orderKey: string;
  shiftId: string;
  orderNumber: number;
  priceCents: number;
  tipCents: number;
  score: number;
  feedback: string[];
  servedItemIds: string[];
  balanceAfterCents: number;
  createdAt: string;
}

export interface SaleResult {
  /** True when this order had already been paid; the original result is returned. */
  duplicate: boolean;
  sale: SaleRecord;
}

export interface PurchaseInput {
  lease: Lease;
  /** Client command id scoped to the profile, for idempotency. */
  purchaseKey: string;
  stockKey: StockKey;
  quantity: number;
  priceCents: number;
}

export interface PurchaseResult {
  duplicate: boolean;
  ok: boolean;
  reason?: string;
  balanceCents: number;
  stock: Record<StockKey, number>;
}

export interface CheckpointData {
  schema: number;
  savedAt: string;
  /** Opaque transient simulation snapshot (items, cooking, orders, equipment). */
  snapshot: unknown;
}

export interface ShiftSummaryInput {
  lease: Lease;
  shiftId: string;
  revenueCents: number;
  costCents: number;
  wasteCents: number;
  served: number;
  refused: number;
}

export class LeaseLostError extends Error {
  constructor(restaurantId: string) {
    super(`Lease lost for restaurant ${restaurantId}`);
    this.name = "LeaseLostError";
  }
}

export interface Store {
  readonly kind: "memory" | "postgres";
  init(): Promise<void>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;

  createProfile(name: string): Promise<Profile>;
  getProfile(id: string): Promise<Profile | null>;

  createRestaurant(ownerId: string, name: string): Promise<RestaurantRecord>;
  listRestaurants(ownerId: string): Promise<RestaurantRecord[]>;
  getRestaurant(id: string): Promise<RestaurantRecord | null>;
  /** Owner or explicitly granted staff permission. */
  canOpen(profileId: string, restaurantId: string): Promise<boolean>;

  acquireLease(restaurantId: string, holder: string, ttlMs: number): Promise<Lease | null>;
  renewLease(lease: Lease, ttlMs: number): Promise<boolean>;
  releaseLease(lease: Lease): Promise<void>;

  saveCheckpoint(lease: Lease, data: CheckpointData, stock: Record<StockKey, number>): Promise<void>;
  loadCheckpoint(restaurantId: string): Promise<CheckpointData | null>;

  commitSale(input: SaleInput): Promise<SaleResult>;
  salesForShift(restaurantId: string, shiftId: string): Promise<SaleRecord[]>;
  purchaseStock(input: PurchaseInput): Promise<PurchaseResult>;
  recordShiftSummary(input: ShiftSummaryInput): Promise<void>;

  exportRestaurant(restaurantId: string): Promise<Record<string, unknown> | null>;
}
