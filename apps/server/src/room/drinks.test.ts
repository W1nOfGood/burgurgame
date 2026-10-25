import { beforeAll, describe, expect, it } from "vitest";
import { FRYER, NET, SODA_FOUNTAIN, drinkCode, type StockKey } from "@ahb/data";
import { createPhysicsWorld, initPhysics, restingHeight, type Rapier } from "@ahb/simulation";
import { RestaurantState } from "@ahb/protocol";
import { Kitchen, type KitchenHooks, type ServeRequest } from "./kitchen.js";

let R: Rapier;
beforeAll(async () => {
  R = await initPhysics();
});

function kitchen() {
  const state = new RestaurantState();
  const toasts: string[] = [];
  const serves: ServeRequest[] = [];
  const hooks: KitchenHooks = {
    toast: (_s, t) => void toasts.push(t),
    broadcastToast: () => undefined,
    requestServe: (r) => void serves.push(r),
    shiftEnded: () => undefined,
  };
  const k = new Kitchen(createPhysicsWorld(R, 1 / NET.tickHz), state, hooks, { mode: "relaxed", seed: 3, stock: {} as Record<StockKey, number>, balanceCents: 0, name: "Drinks" });
  (k as unknown as { openShift(): void }).openShift();
  (k as unknown as { nextOrderAt: number }).nextOrderAt = Infinity;
  return { k, state, toasts, serves };
}

type Priv = {
  createItem(kind: string, pos: { x: number; y: number; z: number }): { id: string; pos: { x: number; y: number; z: number }; level: number; drink: number; body: unknown };
  ensureBody(it: unknown): void;
  checkPickup(it: unknown, by: string): void;
  items: Map<string, any>;
};

const step = (k: Kitchen, seconds: number) => {
  for (let i = 0; i < seconds * NET.tickHz; i++) k.step(1 / NET.tickHz);
};

/** A cup standing on the drip tray under valve `v`. */
function cupUnder(k: Kitchen, v: number) {
  const p = k as unknown as Priv;
  const cup = p.createItem("cup", { x: SODA_FOUNTAIN.valveX[v]!, y: SODA_FOUNTAIN.trayY + restingHeight("cup"), z: 1.2 });
  p.ensureBody(cup);
  return cup;
}

describe("fountain drinks", () => {
  it("fills a cup under a valve with that valve's drink, in about three seconds", () => {
    const { k, state } = kitchen();
    const cup = cupUnder(k, 5); // the last valve: Fizz Cola
    step(k, 1.5);
    expect(cup.level).toBeGreaterThan(0.3);
    expect(cup.level).toBeLessThan(0.7);
    step(k, 2);
    expect(cup.level).toBe(1);
    expect(cup.drink).toBe(drinkCode("cola"));
    expect(state.items.get(cup.id)!.drink).toBe(drinkCode("cola"));
    expect(state.items.get(cup.id)!.level).toBe(255);
  });

  it("keeps one drink per cup", () => {
    const { k } = kitchen();
    const cup = cupUnder(k, 0);
    step(k, 1);
    const half = cup.level;
    expect(cup.drink).toBe(drinkCode("iced_tea"));
    (cup.body as { setTranslation(t: { x: number; y: number; z: number }, wake: boolean): void }).setTranslation({ x: SODA_FOUNTAIN.valveX[5]!, y: cup.pos.y, z: 1.2 }, true);
    step(k, 2);
    expect(cup.drink).toBe(drinkCode("iced_tea"));
    expect(cup.level).toBe(half); // the cola valve does not top up a tea
  });

  it("does not fill a cup that is not under a valve", () => {
    const { k } = kitchen();
    const p = k as unknown as Priv;
    const cup = p.createItem("cup", { x: -1, y: 1.0 + restingHeight("cup"), z: 0 });
    p.ensureBody(cup);
    step(k, 4);
    expect(cup.level).toBe(0);
  });

  it("serves a ticket's drink only with a full cup of it beside the burger", () => {
    const { k, state, toasts, serves } = kitchen();
    const p = k as unknown as Priv;
    // A finished plain burger on a tray on the pickup shelf.
    const tray = p.createItem("tray", { x: -0.4, y: 1.0 + restingHeight("tray"), z: 0 });
    p.ensureBody(tray);
    const stackOn = (parent: any, kind: string) => {
      const it = p.createItem(kind, parent.pos);
      parent.child = it.id;
      (it as any).parent = parent.id;
      return it as any;
    };
    const bun = stackOn(tray, "bun_bottom");
    const patty = stackOn(bun, "patty");
    (patty.food as any).cookA = 0.9;
    (patty.food as any).cookB = 0.9;
    (patty.food as any).inner = 0.95;
    stackOn(patty, "bun_top");
    k.createOrder("starter", [], "cola");
    const burgerRev = state.items.get(tray.id)!.rev;
    p.checkPickup(tray, "p1");
    expect(serves).toHaveLength(0);
    expect(toasts.some((t) => t.includes("Fizz Cola"))).toBe(true);
    void burgerRev;
    // A half-full cup is not enough; a full one is, and setting it down is what serves.
    const cup = p.createItem("cup", { x: 0.1, y: 1.0 + restingHeight("cup"), z: 0.1 });
    p.ensureBody(cup);
    cup.drink = drinkCode("cola");
    cup.level = 0.5;
    p.checkPickup(cup, "p1");
    expect(serves).toHaveLength(0);
    cup.level = 1;
    p.checkPickup(cup, "p1");
    expect(serves).toHaveLength(1);
    expect(serves[0]!.extraIds).toEqual([cup.id]);
    expect(serves[0]!.servedItemIds).toContain(cup.id);
    expect(serves[0]!.evaluation.priceCents).toBeGreaterThanOrEqual(500 + 200);
  });
});

describe("fries", () => {
  const vatSpot = (v: number) => ({ x: (FRYER.vats[v]!.minX + FRYER.vats[v]!.maxX) / 2, y: FRYER.deckY + restingHeight("fries"), z: 4.55 });

  it("cooks in the oil, goes golden, then burns if left", () => {
    const { k } = kitchen();
    const p = k as unknown as Priv;
    const f = p.createItem("fries", vatSpot(0)) as any;
    p.ensureBody(f);
    step(k, 20);
    expect(f.food.cookA).toBeGreaterThan(0.4);
    expect(f.food.cookA).toBeLessThan(0.6);
    step(k, 20);
    expect(f.food.cookA).toBeGreaterThanOrEqual(FRYER.servedAt);
    expect(f.food.burn).toBe(0);
    step(k, 25);
    expect(f.food.burn).toBeGreaterThan(FRYER.burntAbove);
  });

  it("does not cook away from the oil", () => {
    const { k } = kitchen();
    const p = k as unknown as Priv;
    const f = p.createItem("fries", { x: -1, y: 1.0 + restingHeight("fries"), z: 0 }) as any;
    p.ensureBody(f);
    step(k, 30);
    expect(f.food.cookA).toBe(0);
  });

  it("serves a ticket's fries only when a good portion is on the shelf", () => {
    const { k, state, toasts, serves } = kitchen();
    const p = k as unknown as Priv;
    const tray = p.createItem("tray", { x: -0.4, y: 1.0 + restingHeight("tray"), z: 0 });
    p.ensureBody(tray);
    const stackOn = (parent: any, kind: string) => {
      const it = p.createItem(kind, parent.pos) as any;
      parent.child = it.id;
      it.parent = parent.id;
      return it;
    };
    const bun = stackOn(tray, "bun_bottom");
    const patty = stackOn(bun, "patty");
    Object.assign(patty.food, { cookA: 0.9, cookB: 0.9, inner: 0.95 });
    stackOn(patty, "bun_top");
    (k as unknown as { addOrder(...a: unknown[]): unknown }).addOrder("starter", [], "Nok", "", "fries");
    p.checkPickup(tray, "p1");
    expect(serves).toHaveLength(0);
    expect(toasts.some((t) => t.includes("fries"))).toBe(true);
    const f = p.createItem("fries", { x: 0.1, y: 1.0 + restingHeight("fries"), z: 0.1 }) as any;
    p.ensureBody(f);
    f.food.cookA = 0.3; // raw
    p.checkPickup(f, "p1");
    expect(serves).toHaveLength(0);
    f.food.cookA = 1;
    f.food.burn = 0.5; // burnt
    p.checkPickup(f, "p1");
    expect(serves).toHaveLength(0);
    f.food.burn = 0;
    p.checkPickup(f, "p1");
    expect(serves).toHaveLength(1);
    expect(serves[0]!.extraIds).toEqual([f.id]);
    expect(serves[0]!.evaluation.priceCents).toBeGreaterThanOrEqual(500 + 300);
  });
});
