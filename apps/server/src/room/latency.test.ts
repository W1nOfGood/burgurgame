import { beforeAll, describe, expect, it } from "vitest";
import { NET, type StockKey } from "@ahb/data";
import { PlayerMotor, createPhysicsWorld, initPhysics, type MoveSample, type Rapier } from "@ahb/simulation";
import { RestaurantState } from "@ahb/protocol";
import { Kitchen, type KitchenHooks } from "./kitchen.js";

/**
 * A client on a long route (e.g. Thailand to a US server, ~250 ms with jitter) simulates every
 * movement step locally, but its input reaches the server in bursts after stalls. The server
 * must run every one of those steps, or the client's prediction is pulled back ("warping").
 */

let R: Rapier;
beforeAll(async () => {
  R = await initPhysics();
});

const DT = 1 / NET.tickHz;

function setup() {
  const state = new RestaurantState();
  const hooks: KitchenHooks = { toast: () => undefined, broadcastToast: () => undefined, requestServe: () => undefined, shiftEnded: () => undefined };
  const k = new Kitchen(createPhysicsWorld(R, DT), state, hooks, { mode: "relaxed", seed: 3, stock: {} as Record<StockKey, number>, balanceCents: 0, name: "Lag" });
  const s = k.addPlayer("p1", { name: "Somchai", platform: "desktop" });
  const client = new PlayerMotor(createPhysicsWorld(R, DT), { x: s.x, y: s.y, z: s.z });
  return { k, state, s, client };
}

/** A walk with turns and a sprint, as the client simulated it. */
function walk(n: number): MoveSample[] {
  const out: MoveSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / NET.tickHz;
    out.push({ seq: i + 1, mx: Math.sin(t * 1.3) * 0.6, mz: 1, yaw: Math.PI + Math.sin(t * 0.7) * 0.9, pitch: 0.1, buttons: i % 240 < 120 ? 2 : 0 });
  }
  return out;
}

describe("movement over a long, jittery route", () => {
  it("runs every sample the client simulated, even when input arrives in bursts after stalls", () => {
    const { k, s, client } = setup();
    const samples = walk(900);
    for (const smp of samples) client.step(smp, DT, 1);
    // Delivery: messages of up to 6 samples, mostly steady, with stalls of 0.3-1.2 s after which
    // everything sent meanwhile arrives at once.
    const stalls = new Map([[120, 18], [300, 45], [520, 72], [700, 30]]);
    let sent = 0;
    let tick = 0;
    let hold: MoveSample[] = [];
    while (sent < samples.length || hold.length) {
      // The client produces one sample per tick and sends every other tick.
      if (sent < samples.length) hold.push(samples[sent++]!);
      const stall = [...stalls.entries()].find(([at, len]) => tick >= at && tick < at + len);
      if (!stall && tick % 2 === 0) {
        while (hold.length) k.pushInput("p1", { samples: hold.splice(0, NET.maxSamplesPerMessage) } as never);
      }
      k.step(DT);
      tick++;
      if (tick > 5000) break;
    }
    for (let i = 0; i < 200; i++) k.step(DT);
    expect(s.ack).toBe(samples.length);
    const c = client.state;
    // Not just close: the server's motor world holds exactly what the client predicts against.
    expect(Math.hypot(s.x - c.x, s.y - c.y, s.z - c.z)).toBeLessThan(1e-9);
  });

  it("still cannot be made to move faster than real time", () => {
    const { k } = setup();
    const motor = (k as unknown as { players: Map<string, { motor: PlayerMotor }> }).players.get("p1")!.motor;
    let steps = 0;
    const step = motor.step.bind(motor);
    motor.step = (...a: Parameters<PlayerMotor["step"]>) => {
      steps++;
      return step(...a);
    };
    // 10 s of input sent at once: in one second the server runs at most a second of movement
    // plus the 2 s it lets a lagging client catch up on.
    const samples = walk(600);
    for (let i = 0; i < samples.length; i += NET.maxSamplesPerMessage) k.pushInput("p1", { samples: samples.slice(i, i + NET.maxSamplesPerMessage) } as never);
    for (let i = 0; i < NET.tickHz; i++) k.step(DT);
    expect(steps).toBeLessThanOrEqual(NET.maxQueuedSamples + NET.tickHz);
  });
});
