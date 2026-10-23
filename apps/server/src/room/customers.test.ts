import { beforeAll, describe, expect, it } from "vitest";
import { NET, SHIFT, customerName, type StockKey } from "@ahb/data";
import { collectTicks, createPhysicsWorld, initPhysics, phaseTicks, type Rapier } from "@ahb/simulation";
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
    expect(c.phase).toBe("waiting");
    const order = state.orders.get(c.order)!;
    expect(order.status).toBe("open");
    expect(order.customer).toBe(customerName(c.seed));
  });

  it("take the food at the shelf after it is paid for, then walk out", () => {
    const { k, state } = kitchen();
    const c = k.spawnCustomer(42)!;
    step(k, phaseTicks(timeline(c)) + 1);
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
    const snap = k.snapshot();
    const { k: k2, state: s2 } = kitchen();
    k2.restore(snap, []);
    const [, c2] = only(s2);
    expect(c2.phase).toBe("waiting");
    expect(c2.seed).toBe(9);
    expect(s2.orders.get(c2.order)!.customer).toBe(state.orders.get(c.order)!.customer);
  });

  it("let the shift close only after everyone walking in has ordered", () => {
    const { k, state } = kitchen();
    const c = k.spawnCustomer(4)!;
    state.phase = "closing";
    step(k, 10);
    expect(state.phase).toBe("closing");
    step(k, phaseTicks(timeline(c)));
    expect(state.orders.get(c.order)!.status).toBe("open");
    expect(state.phase).toBe("closing");
  });
});
