import { randomUUID } from "node:crypto";
import pg from "pg";
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

type Client = pg.PoolClient;

interface RestaurantRow {
  id: string;
  owner_id: string;
  name: string;
  balance_cents: string;
  stock: Record<StockKey, number>;
  upgrades: string[];
  version: string;
  created_at: Date;
}

function toRestaurant(row: RestaurantRow): RestaurantRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    balanceCents: Number(row.balance_cents),
    stock: row.stock,
    upgrades: row.upgrades,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
  };
}

interface SaleRow {
  order_key: string;
  shift_id: string;
  order_number: number;
  price_cents: number;
  tip_cents: number;
  score: number;
  feedback: string[];
  served_item_ids: string[];
  balance_after_cents: string;
  created_at: Date;
}

function toSale(row: SaleRow): SaleRecord {
  return {
    orderKey: row.order_key,
    shiftId: row.shift_id,
    orderNumber: row.order_number,
    priceCents: row.price_cents,
    tipCents: row.tip_cents,
    score: row.score,
    feedback: row.feedback,
    servedItemIds: row.served_item_ids,
    balanceAfterCents: Number(row.balance_after_cents),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * PostgreSQL store. All database work is asynchronous and pooled so a room's simulation loop
 * never blocks on it (spec §14).
 */
export class PostgresStore implements Store {
  readonly kind = "postgres" as const;
  readonly pool: pg.Pool;

  constructor(connectionString: string, poolSize = 10) {
    this.pool = new pg.Pool({
      connectionString,
      max: poolSize,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });
    this.pool.on("error", () => {
      // Idle client errors surface through healthy(); avoid crashing the process.
    });
  }

  async init(): Promise<void> {
    const res = await this.pool.query<{ exists: boolean }>("SELECT to_regclass('public.restaurants') IS NOT NULL AS exists");
    if (!res.rows[0]?.exists) throw new Error("Database schema missing: run migrations first (npm run migrate)");
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  /** Locks the lease row and throws if this room no longer holds the fencing token. */
  private async fence(c: Client, lease: Lease): Promise<void> {
    const res = await c.query<{ holder: string | null; epoch: string }>(
      "SELECT holder, epoch FROM restaurant_leases WHERE restaurant_id = $1 FOR UPDATE",
      [lease.restaurantId],
    );
    const row = res.rows[0];
    if (!row || row.holder !== lease.holder || Number(row.epoch) !== lease.epoch) throw new LeaseLostError(lease.restaurantId);
  }

  async createProfile(name: string): Promise<Profile> {
    const id = randomUUID();
    const res = await this.pool.query<{ created_at: Date }>("INSERT INTO profiles (id, name) VALUES ($1, $2) RETURNING created_at", [id, name]);
    return { id, name, createdAt: res.rows[0]!.created_at.toISOString() };
  }

  async getProfile(id: string): Promise<Profile | null> {
    const res = await this.pool.query<{ id: string; name: string; created_at: Date }>("SELECT id, name, created_at FROM profiles WHERE id = $1", [id]);
    const row = res.rows[0];
    return row ? { id: row.id, name: row.name, createdAt: row.created_at.toISOString() } : null;
  }

  async createRestaurant(ownerId: string, name: string): Promise<RestaurantRecord> {
    const res = await this.pool.query<RestaurantRow>(
      `INSERT INTO restaurants (id, owner_id, name, balance_cents, stock)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), ownerId, name, STARTING_BALANCE_CENTS, JSON.stringify(STARTING_STOCK)],
    );
    return toRestaurant(res.rows[0]!);
  }

  async listRestaurants(ownerId: string): Promise<RestaurantRecord[]> {
    const res = await this.pool.query<RestaurantRow>("SELECT * FROM restaurants WHERE owner_id = $1 ORDER BY created_at", [ownerId]);
    return res.rows.map(toRestaurant);
  }

  async getRestaurant(id: string): Promise<RestaurantRecord | null> {
    const res = await this.pool.query<RestaurantRow>("SELECT * FROM restaurants WHERE id = $1", [id]);
    return res.rows[0] ? toRestaurant(res.rows[0]) : null;
  }

  async canOpen(profileId: string, restaurantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM restaurants r
       LEFT JOIN restaurant_permissions p ON p.restaurant_id = r.id AND p.profile_id = $1
       WHERE r.id = $2 AND (r.owner_id = $1 OR p.profile_id IS NOT NULL)`,
      [profileId, restaurantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async acquireLease(restaurantId: string, holder: string, ttlMs: number): Promise<Lease | null> {
    const res = await this.pool.query<{ holder: string; epoch: string }>(
      `INSERT INTO restaurant_leases AS l (restaurant_id, holder, epoch, expires_at)
       SELECT $1, $2, 1, now() + make_interval(secs => $3::double precision / 1000)
       WHERE EXISTS (SELECT 1 FROM restaurants WHERE id = $1)
       ON CONFLICT (restaurant_id) DO UPDATE
         SET holder = EXCLUDED.holder,
             epoch = CASE WHEN l.holder = EXCLUDED.holder THEN l.epoch ELSE l.epoch + 1 END,
             expires_at = EXCLUDED.expires_at
         WHERE l.holder IS NULL OR l.holder = EXCLUDED.holder OR l.expires_at < now()
       RETURNING holder, epoch`,
      [restaurantId, holder, ttlMs],
    );
    const row = res.rows[0];
    return row ? { restaurantId, holder: row.holder, epoch: Number(row.epoch) } : null;
  }

  async renewLease(lease: Lease, ttlMs: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE restaurant_leases SET expires_at = now() + make_interval(secs => $4::double precision / 1000)
       WHERE restaurant_id = $1 AND holder = $2 AND epoch = $3`,
      [lease.restaurantId, lease.holder, lease.epoch, ttlMs],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async releaseLease(lease: Lease): Promise<void> {
    await this.pool.query(
      `UPDATE restaurant_leases SET holder = NULL, expires_at = 'epoch'
       WHERE restaurant_id = $1 AND holder = $2 AND epoch = $3`,
      [lease.restaurantId, lease.holder, lease.epoch],
    );
  }

  async saveCheckpoint(lease: Lease, data: CheckpointData, stock: Record<StockKey, number>): Promise<void> {
    await this.tx(async (c) => {
      await this.fence(c, lease);
      await c.query(
        `INSERT INTO restaurant_checkpoints (restaurant_id, lease_epoch, data, saved_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (restaurant_id) DO UPDATE SET lease_epoch = EXCLUDED.lease_epoch, data = EXCLUDED.data, saved_at = now()`,
        [lease.restaurantId, lease.epoch, JSON.stringify(data)],
      );
      await c.query("UPDATE restaurants SET stock = $2, version = version + 1, updated_at = now() WHERE id = $1", [
        lease.restaurantId,
        JSON.stringify(stock),
      ]);
    });
  }

  async loadCheckpoint(restaurantId: string): Promise<CheckpointData | null> {
    const res = await this.pool.query<{ data: CheckpointData }>("SELECT data FROM restaurant_checkpoints WHERE restaurant_id = $1", [restaurantId]);
    return res.rows[0]?.data ?? null;
  }

  async commitSale(input: SaleInput): Promise<SaleResult> {
    const { lease } = input;
    return this.tx(async (c) => {
      const prior = await c.query<SaleRow>("SELECT * FROM sales WHERE restaurant_id = $1 AND order_key = $2", [lease.restaurantId, input.orderKey]);
      if (prior.rows[0]) return { duplicate: true, sale: toSale(prior.rows[0]) };
      await this.fence(c, lease);
      // Re-check under the lease lock: a concurrent duplicate would have committed first.
      const again = await c.query<SaleRow>("SELECT * FROM sales WHERE restaurant_id = $1 AND order_key = $2", [lease.restaurantId, input.orderKey]);
      if (again.rows[0]) return { duplicate: true, sale: toSale(again.rows[0]) };
      const amount = input.priceCents + input.tipCents;
      const bal = await c.query<{ balance_cents: string }>(
        "UPDATE restaurants SET balance_cents = balance_cents + $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING balance_cents",
        [lease.restaurantId, amount],
      );
      const balanceAfter = Number(bal.rows[0]!.balance_cents);
      const ins = await c.query<SaleRow>(
        `INSERT INTO sales (restaurant_id, order_key, shift_id, order_number, price_cents, tip_cents, score, feedback, served_item_ids, balance_after_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          lease.restaurantId,
          input.orderKey,
          input.shiftId,
          input.orderNumber,
          input.priceCents,
          input.tipCents,
          input.score,
          JSON.stringify(input.feedback),
          JSON.stringify(input.servedItemIds),
          balanceAfter,
        ],
      );
      await c.query("INSERT INTO economic_events (restaurant_id, kind, amount_cents, ref) VALUES ($1, 'sale', $2, $3)", [
        lease.restaurantId,
        amount,
        input.orderKey,
      ]);
      return { duplicate: false, sale: toSale(ins.rows[0]!) };
    });
  }

  async salesForShift(restaurantId: string, shiftId: string): Promise<SaleRecord[]> {
    const res = await this.pool.query<SaleRow>("SELECT * FROM sales WHERE restaurant_id = $1 AND shift_id = $2 ORDER BY order_number", [
      restaurantId,
      shiftId,
    ]);
    return res.rows.map(toSale);
  }

  async purchaseStock(input: PurchaseInput): Promise<PurchaseResult> {
    const { lease } = input;
    return this.tx(async (c) => {
      const prior = await c.query<{ result: PurchaseResult }>("SELECT result FROM purchases WHERE restaurant_id = $1 AND purchase_key = $2", [
        lease.restaurantId,
        input.purchaseKey,
      ]);
      if (prior.rows[0]) return { ...prior.rows[0].result, duplicate: true };
      await this.fence(c, lease);
      const r = await c.query<RestaurantRow>("SELECT * FROM restaurants WHERE id = $1 FOR UPDATE", [lease.restaurantId]);
      const rest = toRestaurant(r.rows[0]!);
      let result: PurchaseResult;
      if (rest.balanceCents < input.priceCents) {
        result = { duplicate: false, ok: false, reason: "Not enough money", balanceCents: rest.balanceCents, stock: rest.stock };
      } else {
        const stock = { ...rest.stock, [input.stockKey]: (rest.stock[input.stockKey] ?? 0) + input.quantity };
        const upd = await c.query<{ balance_cents: string }>(
          "UPDATE restaurants SET balance_cents = balance_cents - $2, stock = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING balance_cents",
          [lease.restaurantId, input.priceCents, JSON.stringify(stock)],
        );
        await c.query("INSERT INTO economic_events (restaurant_id, kind, amount_cents, ref) VALUES ($1, 'purchase', $2, $3)", [
          lease.restaurantId,
          -input.priceCents,
          input.purchaseKey,
        ]);
        result = { duplicate: false, ok: true, balanceCents: Number(upd.rows[0]!.balance_cents), stock };
      }
      await c.query(
        "INSERT INTO purchases (restaurant_id, purchase_key, stock_key, quantity, price_cents, result) VALUES ($1, $2, $3, $4, $5, $6)",
        [lease.restaurantId, input.purchaseKey, input.stockKey, input.quantity, input.priceCents, JSON.stringify(result)],
      );
      return result;
    });
  }

  async recordShiftSummary(input: ShiftSummaryInput): Promise<void> {
    await this.tx(async (c) => {
      await this.fence(c, input.lease);
      await c.query(
        `INSERT INTO shift_summaries (restaurant_id, shift_id, revenue_cents, cost_cents, waste_cents, served, refused)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (restaurant_id, shift_id) DO NOTHING`,
        [input.lease.restaurantId, input.shiftId, input.revenueCents, input.costCents, input.wasteCents, input.served, input.refused],
      );
    });
  }

  async exportRestaurant(restaurantId: string): Promise<Record<string, unknown> | null> {
    const restaurant = await this.getRestaurant(restaurantId);
    if (!restaurant) return null;
    const checkpoint = await this.loadCheckpoint(restaurantId);
    const sales = await this.pool.query<SaleRow>("SELECT * FROM sales WHERE restaurant_id = $1 ORDER BY created_at", [restaurantId]);
    return { exportVersion: 1, restaurant, checkpoint, sales: sales.rows.map(toSale) };
  }
}
