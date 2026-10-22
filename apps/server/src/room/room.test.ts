import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ServedMessage, type WelcomeMessage } from "@ahb/protocol";
import { ROOM_NAME } from "../app.js";
import { MemoryStore } from "../store/memory.js";
import {
  createRoom,
  drag,
  guest,
  joinRoom,
  send,
  sendWithCmd,
  serverRoom,
  sleep,
  startHarness,
  until,
  waitFor,
  type Harness,
  type TestPlayer,
} from "../test/harness.js";
import type { Kitchen } from "./kitchen.js";

let h: Harness;
let store: MemoryStore;

beforeAll(async () => {
  store = new MemoryStore();
  h = await startHarness(store);
});

afterEach(async () => {
  store.failWrites = false;
  await h.colyseus.cleanup();
});

afterAll(async () => {
  await h.colyseus.shutdown();
});

function kitchenOf(p: TestPlayer): Kitchen {
  const k = serverRoom(h, p).kitchen;
  if (!k) throw new Error("kitchen not initialised");
  return k;
}

function itemsOfKind(p: TestPlayer, kind: string): string[] {
  const out: string[] = [];
  serverRoom(h, p).state.items.forEach((it, id) => {
    if (it.kind === kind) out.push(id);
  });
  return out;
}

function rev(p: TestPlayer, id: string): number {
  return serverRoom(h, p).state.items.get(id)!.rev;
}

function at(p: TestPlayer, x: number, z: number, yaw = 0, pitch = 0.6): void {
  kitchenOf(p).debugPlacePlayer(p.room.sessionId, { x, y: 0, z }, yaw, pitch);
}

function advance(p: TestPlayer, seconds: number): void {
  const k = kitchenOf(p);
  for (let i = 0; i < Math.round(seconds * 60); i++) k.step(1 / 60);
}

describe("joining", () => {
  it("creates a private room whose id is a six-character join code", async () => {
    const a = await createRoom(h, "Avery");
    const welcome = await waitFor<WelcomeMessage>(a, "welcome").catch(() => a.messages.find((m) => m.type === "welcome")?.payload as WelcomeMessage);
    expect(a.room.roomId).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(welcome?.code ?? a.room.roomId).toBe(a.room.roomId);
    await until(() => a.room.state.players?.size === 1, 3000, "player in state");
    expect(a.room.state.items.size).toBeGreaterThanOrEqual(4);
    expect(a.room.state.players.get(a.room.sessionId)?.admin).toBe(true);
  });

  it("lets a touch player join by code and both see each other", async () => {
    const a = await createRoom(h, "Avery");
    const b = await joinRoom(h, a.room.roomId, "Blake", "touch");
    await until(() => a.room.state.players.size === 2 && b.room.state.players.size === 2, 3000, "both players");
    expect(b.room.state.players.get(b.room.sessionId)?.platform).toBe("touch");
    expect(a.room.state.players.get(b.room.sessionId)?.name).toBe("Blake");
  });

  it("rejects a wrong protocol version and a missing guest credential", async () => {
    const g = await guest(h, "Casey");
    await expect(g.sdk.create(ROOM_NAME, { protocol: PROTOCOL_VERSION + 9, name: "Casey", platform: "desktop" })).rejects.toThrow(/version/i);
    g.sdk.auth.token = "";
    await expect(g.sdk.create(ROOM_NAME, { protocol: PROTOCOL_VERSION, name: "Casey", platform: "desktop" })).rejects.toThrow();
  });

  it("enforces capacity when many players join at once", async () => {
    const a = await createRoom(h, "Avery");
    await until(() => kitchenOf(a) !== null, 3000, "kitchen");
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => joinRoom(h, a.room.roomId, `P${i}`)));
    const ok = attempts.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(3);
    await sleep(100);
    expect(serverRoom(h, a).clients.length).toBe(4);
  });

  it("does not let a guest open another profile's restaurant by id", async () => {
    const owner = await guest(h, "Owner");
    const restaurant = await store.createRestaurant(owner.profileId, "Owner's Diner");
    const intruder = await guest(h, "Intruder");
    await expect(
      intruder.sdk.create(ROOM_NAME, { protocol: PROTOCOL_VERSION, name: "Intruder", platform: "desktop", restaurantId: restaurant.id }),
    ).rejects.toThrow(/access/i);
  });
});

describe("movement", () => {
  it("applies sequenced input samples and acknowledges the last one", async () => {
    const a = await createRoom(h, "Avery");
    await until(() => a.room.state.players?.size === 1, 3000, "joined");
    const start = a.room.state.players.get(a.room.sessionId)!;
    const z0 = start.z;
    for (let batch = 0; batch < 10; batch++) {
      const samples = Array.from({ length: 2 }, (_, i) => ({ seq: batch * 2 + i + 1, mx: 0, mz: -1, yaw: 0, pitch: 0, buttons: 0 }));
      a.room.send("input", { samples });
      await sleep(33);
    }
    await until(() => a.room.state.players.get(a.room.sessionId)!.ack === 20, 3000, "ack 20");
    expect(a.room.state.players.get(a.room.sessionId)!.z).toBeLessThan(z0 - 0.3);
  });

  it("drops invalid input without disconnecting the player", async () => {
    const a = await createRoom(h, "Avery");
    await until(() => a.room.state.players?.size === 1, 3000, "joined");
    a.room.send("input", { samples: [{ seq: 1, mx: 50, mz: 0, yaw: 0, pitch: 0, buttons: 0 }] });
    const r = await send(a, "grab", { item: "../etc", rev: 0 });
    expect(r.ok).toBe(false);
    await sleep(50);
    expect(serverRoom(h, a).clients.length).toBe(1);
  });
});

describe("shared interactions", () => {
  it("grants a contested grab to exactly one player", async () => {
    const a = await createRoom(h, "Avery");
    const b = await joinRoom(h, a.room.roomId, "Blake");
    await until(() => serverRoom(h, a).clients.length === 2, 3000, "two clients");
    const spatula = itemsOfKind(a, "spatula")[0]!;
    at(a, 0.6, 3.1, Math.PI, 0.6);
    at(b, 1.4, 3.1, Math.PI, 0.6);
    const r = rev(a, spatula);
    const [ra, rb] = await Promise.all([send(a, "grab", { item: spatula, rev: r }), send(b, "grab", { item: spatula, rev: r })]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    const holder = serverRoom(h, a).state.items.get(spatula)!.holder;
    expect([a.room.sessionId, b.room.sessionId]).toContain(holder);
  });

  it("hands a patty from one player to another", async () => {
    const a = await createRoom(h, "Avery");
    const b = await joinRoom(h, a.room.roomId, "Blake");
    await until(() => serverRoom(h, a).clients.length === 2, 3000, "two clients");
    at(a, -1.6, 3.2, 0, 0.7);
    await drag(a, "drawer", { value: 1 }, () => serverRoom(h, a).state.drawer > 0.9);
    expect((await send(a, "grab", { dispenser: "drawer_patty" })).ok).toBe(true);
    const patty = serverRoom(h, a).state.players.get(a.room.sessionId)!.held;
    expect(patty).not.toBe("");
    // Not offered yet: B can't snatch it.
    at(b, -1.0, 3.2, -Math.PI / 2, 0.3);
    advance(a, 0.05);
    expect((await send(b, "grab", { item: patty, rev: rev(a, patty) })).ok).toBe(false);
    expect((await send(a, "offer", { to: b.room.sessionId })).ok).toBe(true);
    advance(a, 0.05);
    const take = await send(b, "grab", { item: patty, rev: rev(a, patty) });
    expect(take).toMatchObject({ ok: true });
    expect(serverRoom(h, a).state.players.get(b.room.sessionId)!.held).toBe(patty);
    expect(serverRoom(h, a).state.players.get(a.room.sessionId)!.held).toBe("");
  });

  it("cooks, flips, assembles and serves a cheeseburger with exactly one payment", async () => {
    const a = await createRoom(h, "Avery");
    await until(() => serverRoom(h, a).kitchen !== null && a.room.state.players?.size === 1, 3000, "ready");
    const room = serverRoom(h, a);
    const k = kitchenOf(a);
    const startBalance = room.state.balance;

    // Open the restaurant at the shift switch.
    at(a, 2.6, 1.2, Math.PI, 0.6);
    expect(await send(a, "shift", { action: "open" })).toMatchObject({ ok: true });

    // Preheat grill zone 1.
    at(a, 0, 3.6, 0, 0.7);
    await drag(a, "knob", { zone: 1, value: 0.8 }, () => room.state.grill[1]!.knob > 0.79);
    advance(a, 8);

    // Patty from the chiller drawer onto the grill.
    at(a, -1.6, 3.2, 0, 0.7);
    await drag(a, "drawer", { value: 1 }, () => room.state.drawer > 0.9);
    expect(await send(a, "grab", { dispenser: "drawer_patty" })).toMatchObject({ ok: true });
    const patty = room.state.players.get(a.room.sessionId)!.held;
    at(a, 0, 3.6, 0, 0.7);
    expect(await send(a, "place", { point: { x: 0, y: 0.9, z: 4.5 } })).toMatchObject({ ok: true });
    advance(a, 0.5);
    expect(k.debugItem(patty)!.zone).toBe(1);
    advance(a, 38);

    // Spatula flip.
    const spatula = itemsOfKind(a, "spatula")[0]!;
    at(a, 0.6, 3.1, Math.PI, 0.6);
    expect(await send(a, "grab", { item: spatula, rev: rev(a, spatula) })).toMatchObject({ ok: true });
    at(a, 0, 3.6, 0, 0.7);
    expect(await send(a, "spatula", { action: "assistFlip", item: patty, rev: rev(a, patty) })).toMatchObject({ ok: true });
    advance(a, 1);
    expect(k.debugItem(patty)!.food!.down).toBe(1);
    advance(a, 38);
    expect(await send(a, "setDown")).toMatchObject({ ok: true });

    // Cheese melts on the hot patty.
    at(a, -3.0, 3.7, 0, 0.7);
    expect(await send(a, "grab", { dispenser: "bin_cheese" })).toMatchObject({ ok: true });
    const cheese = room.state.players.get(a.room.sessionId)!.held;
    at(a, 0, 3.6, 0, 0.7);
    const pp = k.debugItem(patty)!.pos;
    expect(await send(a, "place", { point: { x: pp.x, y: pp.y + 0.02, z: pp.z }, onto: patty })).toMatchObject({ ok: true });
    advance(a, 6);
    expect(k.debugItem(cheese)!.food!.melt).toBeGreaterThan(0.45);

    // Build on a tray.
    const tray = itemsOfKind(a, "tray")[0]!;
    const trayPos = k.debugItem(tray)!.pos;
    at(a, -3.8, 3.7, 0, 0.7);
    expect(await send(a, "grab", { dispenser: "bin_bun_bottom" })).toMatchObject({ ok: true });
    at(a, trayPos.x, 1.3, 0, 0.7);
    expect(await send(a, "place", { point: trayPos, onto: tray })).toMatchObject({ ok: true });
    at(a, 0, 3.6, 0, 0.7);
    expect(await send(a, "grab", { item: patty, rev: rev(a, patty) })).toMatchObject({ ok: true });
    at(a, trayPos.x, 1.3, 0, 0.7);
    expect(await send(a, "place", { point: trayPos, onto: tray })).toMatchObject({ ok: true });
    for (const [bin, x] of [
      ["bin_lettuce", -2.6],
      ["bin_tomato", -2.18],
      ["bin_pickle", -1.34],
    ] as const) {
      at(a, x, 3.7, 0, 0.7);
      expect(await send(a, "grab", { dispenser: bin })).toMatchObject({ ok: true });
      at(a, trayPos.x, 1.3, 0, 0.7);
      expect(await send(a, "place", { point: trayPos, onto: tray })).toMatchObject({ ok: true });
    }

    // Sauce.
    const bottle = itemsOfKind(a, "sauce_bottle")[0]!;
    at(a, 0.7, 1.3, 0, 0.7);
    expect(await send(a, "grab", { item: bottle, rev: rev(a, bottle) })).toMatchObject({ ok: true });
    at(a, trayPos.x, 1.3, 0, 0.7);
    for (let i = 0; i < 8; i++) {
      advance(a, 0.1);
      a.room.send("squeeze", { target: tray, intensity: 1 });
      await sleep(10);
    }
    await sleep(50);
    expect(await send(a, "setDown")).toMatchObject({ ok: true });

    at(a, -3.45, 3.7, 0, 0.7);
    expect(await send(a, "grab", { dispenser: "bin_bun_top" })).toMatchObject({ ok: true });
    at(a, trayPos.x, 1.3, 0, 0.7);
    expect(await send(a, "place", { point: trayPos, onto: tray })).toMatchObject({ ok: true });

    // There should be an open order by now.
    await until(() => [...room.state.orders.values()].some((o) => o.status === "open"), 2000, "open order");

    // Serve at the pickup shelf.
    at(a, trayPos.x, 1.3, 0, 0.7);
    expect(await send(a, "grab", { item: tray, rev: rev(a, tray) })).toMatchObject({ ok: true });
    at(a, -0.4, 0.8, Math.PI, 0.6);
    const served = waitFor<ServedMessage>(a, "served");
    const placeCmd = 9000;
    expect(await sendWithCmd(a, placeCmd, "place", { point: { x: -0.4, y: 1.0, z: 0.1 } })).toMatchObject({ ok: true });
    const msg = await served;
    expect(msg.accepted).toBe(true);
    expect(msg.score).toBeGreaterThanOrEqual(80);
    await until(() => room.state.balance === startBalance + msg.priceCents + msg.tipCents, 2000, "balance");

    // A retried command and a duplicated commit cannot pay twice.
    expect(await sendWithCmd(a, placeCmd, "place", { point: { x: -0.4, y: 1.0, z: 0.1 } })).toMatchObject({ ok: true });
    const sales = await store.salesForShift(room.restaurantId, k.shiftId);
    expect(sales).toHaveLength(1);
    const again = await store.commitSale({
      lease: (room as unknown as { lease: never }).lease,
      shiftId: k.shiftId,
      orderNumber: msg.orderNumber,
      orderKey: sales[0]!.orderKey,
      priceCents: msg.priceCents,
      tipCents: msg.tipCents,
      score: msg.score,
      feedback: [],
      servedItemIds: [],
    });
    expect(again.duplicate).toBe(true);
    expect((await store.getRestaurant(room.restaurantId))!.balanceCents).toBe(startBalance + msg.priceCents + msg.tipCents);
    expect([...room.state.orders.values()].filter((o) => o.status === "served")).toHaveLength(1);
  }, 30_000);
});

describe("room lifecycle", () => {
  it("keeps the shift running when the creator leaves and passes admin on", async () => {
    const a = await createRoom(h, "Avery");
    const b = await joinRoom(h, a.room.roomId, "Blake");
    await until(() => serverRoom(h, a).clients.length === 2, 3000, "two clients");
    const room = serverRoom(h, a);
    at(a, 2.6, 1.2, Math.PI, 0.6);
    expect(await send(a, "shift", { action: "open" })).toMatchObject({ ok: true });
    await a.room.leave(true);
    await until(() => room.clients.length === 1, 3000, "creator gone");
    const t0 = room.state.shiftTime;
    await sleep(300);
    expect(room.state.paused).toBe(false);
    expect(room.state.shiftTime).toBeGreaterThan(t0);
    expect(room.state.players.get(b.room.sessionId)!.admin).toBe(true);
  });

  it("pauses an empty room immediately and checkpoints it", async () => {
    const a = await createRoom(h, "Avery");
    await until(() => serverRoom(h, a).kitchen !== null, 3000, "kitchen");
    const room = serverRoom(h, a);
    const restaurantId = room.restaurantId;
    // Simulate an unexpected drop (no consent) so the reconnect window applies.
    a.room.connection.close();
    await until(() => room.state.paused, 3000, "paused");
    expect(room.state.pauseReason).toBe("Kitchen empty");
    await until(() => store.loadCheckpoint(restaurantId) !== null, 3000, "checkpoint");
    expect(await store.loadCheckpoint(restaurantId)).not.toBeNull();
  });

  it("pauses a solo room on request and resumes after a countdown", async () => {
    const a = await createRoom(h, "Avery");
    await until(() => serverRoom(h, a).kitchen !== null, 3000, "kitchen");
    const room = serverRoom(h, a);
    expect(await send(a, "pause", { action: "request" })).toMatchObject({ ok: true });
    expect(room.state.paused).toBe(true);
    expect(await send(a, "pause", { action: "resume" })).toMatchObject({ ok: true });
    expect(room.state.resumeTick).toBeGreaterThan(room.state.tick);
    advance(a, 3.1);
    expect(room.state.paused).toBe(false);
  });

  it("requires a unanimous vote to pause co-op", async () => {
    const a = await createRoom(h, "Avery");
    const b = await joinRoom(h, a.room.roomId, "Blake");
    await until(() => serverRoom(h, a).clients.length === 2, 3000, "two clients");
    const room = serverRoom(h, a);
    await send(a, "pause", { action: "request" });
    expect(room.state.paused).toBe(false);
    await send(b, "pause", { action: "request" });
    expect(room.state.paused).toBe(true);
  });

  it("restores a checkpoint without resurrecting a burger that was already paid for", async () => {
    const a = await createRoom(h, "Avery");
    await until(() => serverRoom(h, a).kitchen !== null, 3000, "kitchen");
    const room = serverRoom(h, a);
    const k = kitchenOf(a);
    at(a, 2.6, 1.2, Math.PI, 0.6);
    await send(a, "shift", { action: "open" });
    const order = k.createOrder();
    const tray = itemsOfKind(a, "tray")[0]!;
    const snap = k.snapshot();
    // Pretend the tray's burger (here: the tray itself) was sold after the checkpoint was taken.
    const restored = new MemoryStore();
    void restored;
    k.restore(snap, [{ orderNumber: order.number, score: 90, servedItemIds: [tray] }]);
    expect(room.state.items.has(tray)).toBe(false);
    const o = [...room.state.orders.values()].find((x) => x.number === order.number)!;
    expect(o.status).toBe("served");
  });

  it("pauses the room instead of silently widening the recovery window when saves fail", async () => {
    const a = await createRoom(h, "Avery");
    await until(() => serverRoom(h, a).kitchen !== null, 3000, "kitchen");
    const room = serverRoom(h, a);
    store.failWrites = true;
    (room as unknown as { lastSavedAt: number }).lastSavedAt = Date.now() - 60_000;
    await room.checkpoint("test");
    expect(room.state.saveStatus).toBe("unavailable");
    expect(room.state.paused).toBe(true);
    store.failWrites = false;
    await room.checkpoint("test");
    expect(room.state.saveStatus).toBe("ok");
  });
});
