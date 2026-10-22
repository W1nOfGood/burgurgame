import { randomUUID } from "node:crypto";
import { STARTING_BALANCE_CENTS, STARTING_STOCK, type StockKey } from "@ahb/data";
import {
  LeaseLostError,
  type CheckpointData,
  type Lease,
  type Profile,
  type PurchaseInput,
  type PurchaseResult,
  type RestaurantRecord,
  type SaleInput,
  type SaleRecord,
  type SaleResult,
  type ShiftSummaryInput,
  type Store,
} from "./types.js";

interface LeaseRow {
  holder: string | null;
  epoch: number;
  expiresAt: number;
}

/**
 * In-process store for development and tests. It mirrors the PostgreSQL semantics that matter
 * for correctness: unique sale keys, idempotent purchases and fenced leases.
 */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private profiles = new Map<string, Profile>();
  private restaurants = new Map<string, RestaurantRecord>();
  private staff = new Map<string, Set<string>>();
  private leases = new Map<string, LeaseRow>();
  private checkpoints = new Map<string, CheckpointData>();
  private sales = new Map<string, SaleRecord & { restaurantId: string }>();
  private purchases = new Map<string, PurchaseResult>();
  private summaries: (ShiftSummaryInput & { at: string })[] = [];
  /** Test hook: when set, durable writes throw to simulate a database outage. */
  failWrites = false;
  now: () => number = () => Date.now();

  async init(): Promise<void> {}
  async healthy(): Promise<boolean> {
    return !this.failWrites;
  }
  async close(): Promise<void> {}

  private guard(): void {
    if (this.failWrites) throw new Error("database unavailable");
  }

  async createProfile(name: string): Promise<Profile> {
    this.guard();
    const p: Profile = { id: randomUUID(), name, createdAt: new Date().toISOString() };
    this.profiles.set(p.id, p);
    return p;
  }

  async getProfile(id: string): Promise<Profile | null> {
    return this.profiles.get(id) ?? null;
  }

  async createRestaurant(ownerId: string, name: string): Promise<RestaurantRecord> {
    this.guard();
    const r: RestaurantRecord = {
      id: randomUUID(),
      ownerId,
      name,
      balanceCents: STARTING_BALANCE_CENTS,
      stock: { ...STARTING_STOCK },
      upgrades: [],
      version: 1,
      createdAt: new Date().toISOString(),
    };
    this.restaurants.set(r.id, r);
    return structuredClone(r);
  }

  async listRestaurants(ownerId: string): Promise<RestaurantRecord[]> {
    return [...this.restaurants.values()].filter((r) => r.ownerId === ownerId).map((r) => structuredClone(r));
  }

  async getRestaurant(id: string): Promise<RestaurantRecord | null> {
    const r = this.restaurants.get(id);
    return r ? structuredClone(r) : null;
  }

  async canOpen(profileId: string, restaurantId: string): Promise<boolean> {
    const r = this.restaurants.get(restaurantId);
    if (!r) return false;
    return r.ownerId === profileId || (this.staff.get(restaurantId)?.has(profileId) ?? false);
  }

  grantStaff(restaurantId: string, profileId: string): void {
    const set = this.staff.get(restaurantId) ?? new Set<string>();
    set.add(profileId);
    this.staff.set(restaurantId, set);
  }

  async acquireLease(restaurantId: string, holder: string, ttlMs: number): Promise<Lease | null> {
    this.guard();
    if (!this.restaurants.has(restaurantId)) return null;
    const row = this.leases.get(restaurantId) ?? { holder: null, epoch: 0, expiresAt: 0 };
    const now = this.now();
    if (row.holder && row.holder !== holder && row.expiresAt > now) return null;
    const epoch = row.holder === holder ? row.epoch : row.epoch + 1;
    this.leases.set(restaurantId, { holder, epoch, expiresAt: now + ttlMs });
    return { restaurantId, holder, epoch };
  }

  private checkLease(lease: Lease): void {
    const row = this.leases.get(lease.restaurantId);
    if (!row || row.holder !== lease.holder || row.epoch !== lease.epoch) throw new LeaseLostError(lease.restaurantId);
  }

  async renewLease(lease: Lease, ttlMs: number): Promise<boolean> {
    this.guard();
    const row = this.leases.get(lease.restaurantId);
    if (!row || row.holder !== lease.holder || row.epoch !== lease.epoch) return false;
    row.expiresAt = this.now() + ttlMs;
    return true;
  }

  async releaseLease(lease: Lease): Promise<void> {
    const row = this.leases.get(lease.restaurantId);
    if (row && row.holder === lease.holder && row.epoch === lease.epoch) {
      row.holder = null;
      row.expiresAt = 0;
    }
  }

  async saveCheckpoint(lease: Lease, data: CheckpointData, stock: Record<StockKey, number>): Promise<void> {
    this.guard();
    this.checkLease(lease);
    this.checkpoints.set(lease.restaurantId, structuredClone(data));
    const r = this.restaurants.get(lease.restaurantId);
    if (r) {
      r.stock = { ...stock };
      r.version++;
    }
  }

  async loadCheckpoint(restaurantId: string): Promise<CheckpointData | null> {
    const c = this.checkpoints.get(restaurantId);
    return c ? structuredClone(c) : null;
  }

  async commitSale(input: SaleInput): Promise<SaleResult> {
    this.guard();
    const key = `${input.lease.restaurantId}|${input.orderKey}`;
    const existing = this.sales.get(key);
    if (existing) return { duplicate: true, sale: strip(existing) };
    this.checkLease(input.lease);
    const r = this.restaurants.get(input.lease.restaurantId);
    if (!r) throw new Error("restaurant missing");
    r.balanceCents += input.priceCents + input.tipCents;
    r.version++;
    const sale: SaleRecord & { restaurantId: string } = {
      restaurantId: r.id,
      orderKey: input.orderKey,
      shiftId: input.shiftId,
      orderNumber: input.orderNumber,
      priceCents: input.priceCents,
      tipCents: input.tipCents,
      score: input.score,
      feedback: [...input.feedback],
      servedItemIds: [...input.servedItemIds],
      balanceAfterCents: r.balanceCents,
      createdAt: new Date().toISOString(),
    };
    this.sales.set(key, sale);
    return { duplicate: false, sale: strip(sale) };
  }

  async salesForShift(restaurantId: string, shiftId: string): Promise<SaleRecord[]> {
    return [...this.sales.values()].filter((s) => s.restaurantId === restaurantId && s.shiftId === shiftId).map(strip);
  }

  async purchaseStock(input: PurchaseInput): Promise<PurchaseResult> {
    this.guard();
    const key = `${input.lease.restaurantId}|${input.purchaseKey}`;
    const prior = this.purchases.get(key);
    if (prior) return { ...structuredClone(prior), duplicate: true };
    this.checkLease(input.lease);
    const r = this.restaurants.get(input.lease.restaurantId);
    if (!r) throw new Error("restaurant missing");
    let result: PurchaseResult;
    if (r.balanceCents < input.priceCents) {
      result = { duplicate: false, ok: false, reason: "Not enough money", balanceCents: r.balanceCents, stock: { ...r.stock } };
    } else {
      r.balanceCents -= input.priceCents;
      r.stock[input.stockKey] += input.quantity;
      r.version++;
      result = { duplicate: false, ok: true, balanceCents: r.balanceCents, stock: { ...r.stock } };
    }
    this.purchases.set(key, structuredClone(result));
    return result;
  }

  async recordShiftSummary(input: ShiftSummaryInput): Promise<void> {
    this.guard();
    this.checkLease(input.lease);
    this.summaries.push({ ...input, at: new Date().toISOString() });
  }

  async exportRestaurant(restaurantId: string): Promise<Record<string, unknown> | null> {
    const r = this.restaurants.get(restaurantId);
    if (!r) return null;
    return {
      exportVersion: 1,
      restaurant: structuredClone(r),
      checkpoint: this.checkpoints.get(restaurantId) ?? null,
      sales: [...this.sales.values()].filter((s) => s.restaurantId === restaurantId).map(strip),
    };
  }
}

function strip(s: SaleRecord & { restaurantId?: string }): SaleRecord {
  const { restaurantId: _ignored, ...rest } = s;
  return structuredClone(rest);
}
