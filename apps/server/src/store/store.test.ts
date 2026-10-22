import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../migrate.js";
import { MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";
import { LeaseLostError, type Store } from "./types.js";

/**
 * Shared persistence contract. Runs against the in-memory store always, and against PostgreSQL
 * when TEST_DATABASE_URL points at a disposable database (it is wiped first).
 */
const PG_URL = process.env.TEST_DATABASE_URL;
const MIGRATIONS = resolve(import.meta.dirname, "../../../../database/migrations");

const targets: { name: string; make: () => Promise<Store>; cleanup?: (s: Store) => Promise<void> }[] = [
  { name: "memory", make: async () => new MemoryStore() },
];
if (PG_URL) {
  targets.push({
    name: "postgres",
    make: async () => {
      const admin = new pg.Client({ connectionString: PG_URL });
      await admin.connect();
      await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await admin.end();
      await migrate(PG_URL, MIGRATIONS, () => undefined);
      const s = new PostgresStore(PG_URL);
      await s.init();
      return s;
    },
    cleanup: (s) => s.close(),
  });
}

for (const target of targets) {
  describe(`${target.name} store`, () => {
    let store: Store;
    beforeAll(async () => {
      store = await target.make();
    });
    afterAll(async () => {
      await target.cleanup?.(store);
    });

    async function setup() {
      const owner = await store.createProfile("Owner");
      const r = await store.createRestaurant(owner.id, "Night Grill");
      const lease = (await store.acquireLease(r.id, `room-${Math.random()}`, 30_000))!;
      return { owner, r, lease };
    }

    it("creates profiles and restaurants with starting balance and stock", async () => {
      const { owner, r } = await setup();
      expect(r.ownerId).toBe(owner.id);
      expect(r.balanceCents).toBeGreaterThan(0);
      expect(r.stock.patty).toBeGreaterThan(0);
      expect((await store.listRestaurants(owner.id)).map((x) => x.id)).toContain(r.id);
      expect(await store.canOpen(owner.id, r.id)).toBe(true);
      const other = await store.createProfile("Other");
      expect(await store.canOpen(other.id, r.id)).toBe(false);
    });

    it("grants one write lease at a time and fences the loser", async () => {
      const { r, lease } = await setup();
      expect(await store.acquireLease(r.id, "someone-else", 30_000)).toBeNull();
      await store.releaseLease(lease);
      const next = await store.acquireLease(r.id, "someone-else", 30_000);
      expect(next).not.toBeNull();
      expect(next!.epoch).toBeGreaterThan(lease.epoch);
      await expect(store.saveCheckpoint(lease, { schema: 1, savedAt: "", snapshot: {} }, r.stock)).rejects.toBeInstanceOf(LeaseLostError);
      await expect(
        store.commitSale({ lease, shiftId: crypto.randomUUID(), orderNumber: 1, orderKey: "x:1", priceCents: 100, tipCents: 0, score: 90, feedback: [], servedItemIds: [] }),
      ).rejects.toBeInstanceOf(LeaseLostError);
    });

    it("takes over an expired lease", async () => {
      const { r, lease } = await setup();
      await store.releaseLease(lease);
      const a = (await store.acquireLease(r.id, "a-room", 1))!;
      await new Promise((res) => setTimeout(res, 20));
      const b = await store.acquireLease(r.id, "b-room", 30_000);
      expect(b).not.toBeNull();
      expect(b!.epoch).toBe(a.epoch + 1);
    });

    it("commits a sale once, even under concurrent duplicates", async () => {
      const { r, lease } = await setup();
      const shiftId = crypto.randomUUID();
      const input = { lease, shiftId, orderNumber: 7, orderKey: `${shiftId}:7`, priceCents: 750, tipCents: 90, score: 95, feedback: ["Perfect burger!"], servedItemIds: ["i5", "i6"] };
      const results = await Promise.all([store.commitSale(input), store.commitSale(input), store.commitSale(input)]);
      expect(results.filter((x) => !x.duplicate)).toHaveLength(1);
      expect(new Set(results.map((x) => x.sale.balanceAfterCents)).size).toBe(1);
      const after = await store.getRestaurant(r.id);
      expect(after!.balanceCents).toBe(r.balanceCents + 840);
      const sales = await store.salesForShift(r.id, shiftId);
      expect(sales).toHaveLength(1);
      expect(sales[0]!.servedItemIds).toEqual(["i5", "i6"]);
    });

    it("makes stock purchases idempotent and refuses overdrafts", async () => {
      const { r, lease } = await setup();
      const buy = { lease, purchaseKey: "p-1", stockKey: "patty" as const, quantity: 20, priceCents: 1600 };
      const first = await store.purchaseStock(buy);
      const second = await store.purchaseStock(buy);
      expect(first.ok).toBe(true);
      expect(second.duplicate).toBe(true);
      expect(second.balanceCents).toBe(first.balanceCents);
      const after = await store.getRestaurant(r.id);
      expect(after!.stock.patty).toBe(r.stock.patty + 20);
      expect(after!.balanceCents).toBe(r.balanceCents - 1600);
      const huge = await store.purchaseStock({ ...buy, purchaseKey: "p-2", priceCents: 10_000_000 });
      expect(huge.ok).toBe(false);
    });

    it("saves and loads checkpoints and exports the restaurant", async () => {
      const { r, lease } = await setup();
      await store.saveCheckpoint(lease, { schema: 1, savedAt: new Date().toISOString(), snapshot: { v: 1, hello: "world" } }, { ...r.stock, patty: 3 });
      const cp = await store.loadCheckpoint(r.id);
      expect((cp!.snapshot as { hello: string }).hello).toBe("world");
      expect((await store.getRestaurant(r.id))!.stock.patty).toBe(3);
      const exported = await store.exportRestaurant(r.id);
      expect(exported).toMatchObject({ exportVersion: 1, restaurant: { id: r.id } });
    });
  });
}
