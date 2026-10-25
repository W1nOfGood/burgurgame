import { beforeAll, describe, expect, it } from "vitest";
import { NET, SHIFT, customerName, type StockKey } from "@ahb/data";
import { collectTicks, createPhysicsWorld, initPhysics, phaseTicks, speak, type Rapier, type WantedOrder } from "@ahb/simulation";
import { RestaurantState, type CustomerState } from "@ahb/protocol";
import { Kitchen, type KitchenHooks, type ServeRequest } from "./kitchen.js";

let R: Rapier;
beforeAll(async () => {
  R = await initPhysics();
});

/** An open shift. With `auto` false no customer walks in unless a test sends one. */
function kitchen(mode: "relaxed" | "normal" = "relaxed", auto = false): { k: Kitchen; state: RestaurantState; toasts: string[] } {
  const state = new RestaurantState();
  const toasts: string[] = [];
  const hooks: KitchenHooks = {
    toast: () => undefined,
    broadcastToast: (t) => void toasts.push(t),
    requestServe: () => undefined,
    shiftEnded: () => undefined,
  };
  const k = new Kitchen(createPhysicsWorld(R, 1 / NET.tickHz), state, hooks, { mode, seed: 7, stock: {} as Record<StockKey, number>, balanceCents: 0, name: "Test" });
  (k as unknown as { openShift(): void }).openShift();
  if (!auto) (k as unknown as { nextOrderAt: number }).nextOrderAt = Infinity;
  return { k, state, toasts };
}

/** A cashier standing behind the register. */
function cashier(k: Kitchen): string {
  k.addPlayer("cashier", { name: "Cashier", platform: "desktop" });
  k.debugPlacePlayer("cashier", { x: -3.5, y: 0, z: 0.9 }, Math.PI, 0.5);
  return "cashier";
}

/** What a customer wants (they said it at the counter; the cashier has to ring it up). */
function wanted(k: Kitchen, id: string): WantedOrder {
  return (k as unknown as { customers: Map<string, { want: WantedOrder }> }).customers.get(id)!.want;
}

function idOf(state: RestaurantState, c: CustomerState): string {
  return [...state.customers.entries()].find(([, v]) => v === c)![0];
}

/** Rings up exactly what the customer said. */
function ringUp(k: Kitchen, state: RestaurantState, c: CustomerState) {
  const id = idOf(state, c);
  return k.ring("cashier", id, wanted(k, id));
}

function step(k: Kitchen, ticks: number): void {
  for (let i = 0; i < ticks; i++) k.step(1 / NET.tickHz);
}

function only(state: RestaurantState): [string, CustomerState] {
  const all = [...state.customers.entries()];
  expect(all).toHaveLength(1);
  return all[0]!;
}

function timeline(c: CustomerState) {
  return { phase: c.phase as "arriving", phaseAt: c.phaseAt, spot: c.spot, seed: c.seed, angry: c.angry };
}

describe("walk-in customers", () => {
  it("walk in first; their ticket prints when they reach the counter", () => {
    const { k, state } = kitchen("relaxed", true);
    step(k, 4 * NET.tickHz + 2);
    const [, c] = only(state);
    expect(c.phase).toBe("arriving");
    expect(c.spot).toBe(0);
    expect(state.orders.size).toBe(0);
    step(k, c.phaseAt + phaseTicks(timeline(c)) - state.tick + 1);
    // At the counter they say what they want; nothing prints until someone rings it up.
    expect(c.phase).toBe("ordering");
    expect(c.say).toBe(speak(wanted(k, idOf(state, c))));
    expect(state.orders.size).toBe(0);
    cashier(k);
    expect(ringUp(k, state, c)).toEqual({ ok: true });
    expect(c.phase).toBe("waiting");
    const order = state.orders.get(c.order)!;
    expect(order.status).toBe("open");
    expect(order.customer).toBe(customerName(c.seed));
  });

  it("send the cashier back when the order is wrong, and say what is wrong", () => {
    const { k, state } = kitchen();
    const c = k.spawnCustomer(2)!;
    step(k, phaseTicks(timeline(c)) + 1);
    cashier(k);
    const id = idOf(state, c);
    const want = wanted(k, id);
    const other = want.recipe === "hamburger" ? "classic_cheeseburger" : "hamburger";
    const wrong = k.ring("cashier", id, { ...want, recipe: other });
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.reason).toContain("not the burger I asked for");
    expect(c.phase).toBe("ordering");
    expect(state.orders.size).toBe(0);
    expect(k.ring("cashier", id, want)).toEqual({ ok: true });
    // Rung twice: the customer has moved on.
    expect(k.ring("cashier", id, want).ok).toBe(false);
  });

  it("need the cashier at the register", () => {
    const { k, state } = kitchen();
    const c = k.spawnCustomer(2)!;
    step(k, phaseTicks(timeline(c)) + 1);
    cashier(k);
    k.debugPlacePlayer("cashier", { x: 3, y: 0, z: 3 }, 0, 0.5);
    const res = ringUp(k, state, c);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/register/);
  });

  it("walk out when nobody takes their order (normal mode only)", () => {
    const normal = kitchen("normal");
    const c = normal.k.spawnCustomer(2)!;
    step(normal.k, phaseTicks(timeline(c)) + 1);
    expect(c.phase).toBe("ordering");
    normal.state.shiftTime += SHIFT.orderPatienceSeconds + 1;
    step(normal.k, 2);
    expect(c.phase).toBe("leaving");
    expect(c.angry).toBe(true);
    expect(normal.toasts.some((t) => t.includes("nobody took their order"))).toBe(true);

    const relaxed = kitchen("relaxed");
    const r = relaxed.k.spawnCustomer(2)!;
    step(relaxed.k, phaseTicks(timeline(r)) + 1);
    relaxed.state.shiftTime += SHIFT.orderPatienceSeconds * 5;
    step(relaxed.k, 2);
    expect(r.phase).toBe("ordering");
  });

  it("take the food at the shelf after it is paid for, then walk out", () => {
    const { k, state } = kitchen();
    const c = k.spawnCustomer(42)!;
    step(k, phaseTicks(timeline(c)) + 1);
    cashier(k);
    expect(ringUp(k, state, c).ok).toBe(true);
    expect(c.phase).toBe("waiting");
    const tray = [...state.items.entries()].find(([, it]) => it.kind === "tray")![0];
    const handed: number[] = [];
    const kk = k as unknown as { handOver(id: string): void };
    const real = kk.handOver.bind(k);
    kk.handOver = (id: string) => {
      handed.push(state.tick);
      real(id);
    };
    const req = { trayId: tray, orderId: c.order, orderNumber: 1, evaluation: { score: 90, priceCents: 900, tipCents: 0 } } as unknown as ServeRequest;
    const servedAt = state.tick;
    k.completeServe(req, 900);
    expect(state.orders.get(c.order)!.status).toBe("served");
    expect(c.phase).toBe("collecting");
    expect(handed).toEqual([]); // the food waits on the tray until they take it
    const { handover, done } = collectTicks(c.spot);
    step(k, done);
    expect(handed).toEqual([servedAt + handover]);
    expect(c.phase).toBe("leaving");
    expect(c.angry).toBe(false);
    step(k, phaseTicks(timeline(c)) + 1);
    expect(state.customers.size).toBe(0);
  });

  it("leave without their food when they run out of patience", () => {
    const { k, state, toasts } = kitchen("normal");
    const c = k.spawnCustomer(3)!;
    step(k, phaseTicks(timeline(c)) + 1);
    cashier(k);
    expect(ringUp(k, state, c).ok).toBe(true);
    expect(c.phase).toBe("waiting");
    const order = state.orders.get(c.order)!;
    state.shiftTime = order.createdAt + SHIFT.patienceSeconds * 2 + 1;
    step(k, 1);
    expect(order.status).toBe("cancelled");
    expect(c.phase).toBe("leaving");
    expect(c.angry).toBe(true);
    expect(toasts.some((t) => t.startsWith(`${customerName(3)} (#`))).toBe(true);
  });

  it("stand still through a pause", () => {
    const { k, state } = kitchen();
    const c = k.spawnCustomer(1)!;
    step(k, 60);
    const at = c.phaseAt;
    k.pause("test");
    step(k, 300);
    (k as unknown as { resume(): void }).resume();
    expect(c.phaseAt).toBe(at + 300);
    expect(state.paused).toBe(false);
  });

  it("are back at the counter after a restore, with their ticket", () => {
    const { k, state } = kitchen();
    const c = k.spawnCustomer(9)!;
    step(k, phaseTicks(timeline(c)) + 1);
    cashier(k);
    expect(ringUp(k, state, c).ok).toBe(true);
    const snap = k.snapshot();
    const { k: k2, state: s2 } = kitchen();
    k2.restore(snap, []);
    const [, c2] = only(s2);
    expect(c2.phase).toBe("waiting");
    expect(c2.seed).toBe(9);
    expect(s2.orders.get(c2.order)!.customer).toBe(state.orders.get(c.order)!.customer);
  });

  it("tell customers still at the counter you're closed, and finish the shift", () => {
    const { k, state } = kitchen();
    const c = k.spawnCustomer(4)!;
    state.phase = "closing";
    step(k, 10);
    expect(state.phase).toBe("closing"); // someone is still walking in
    step(k, phaseTicks(timeline(c)));
    expect(c.phase).toBe("leaving");
    expect(state.orders.size).toBe(0);
    step(k, phaseTicks(timeline(c)) + 2);
    expect(state.phase).toBe("prep");
  });

  it("run the tutorial: one customer wanting the Starter Burger and a cola, nobody else until it is served", () => {
    const { k, state } = kitchen("relaxed", true);
    state.phase = "prep";
    k.startTutorial();
    expect(state.tutorial).toBe(true);
    (k as unknown as { openShift(): void }).openShift();
    step(k, 40 * NET.tickHz);
    const [id, c] = only(state);
    expect(wanted(k, id)).toMatchObject({ recipe: "starter", drink: "cola" });
    expect(c.say).toContain("Starter Burger");
    // Nobody else walks in however long it takes.
    step(k, 300 * NET.tickHz);
    expect(state.customers.size).toBe(1);
    cashier(k);
    expect(ringUp(k, state, c).ok).toBe(true);
    step(k, 120 * NET.tickHz);
    expect(state.customers.size).toBe(1);
    // Serving it ends the tutorial and the shift carries on.
    const tray = [...state.items.entries()].find(([, it]) => it.kind === "tray")![0];
    k.completeServe({ trayId: tray, orderId: c.order, orderNumber: 1, evaluation: { score: 90, priceCents: 700, tipCents: 0 } } as unknown as ServeRequest, 700);
    expect(state.tutorial).toBe(false);
    step(k, 60 * NET.tickHz);
    expect([...state.customers.keys()].some((other) => other !== id)).toBe(true);
  });

  it("let the tutorial be skipped, and replayed before opening", () => {
    const { k, state } = kitchen();
    cashier(k);
    state.phase = "prep";
    expect(k.tutorial("cashier", "start")).toEqual({ ok: true });
    expect(state.tutorial).toBe(true);
    expect(k.tutorial("cashier", "skip")).toEqual({ ok: true });
    expect(state.tutorial).toBe(false);
    state.phase = "open";
    expect(k.tutorial("cashier", "start").ok).toBe(false); // not once the shift has opened
  });
});
