import { beforeAll, describe, expect, it } from "vitest";
import { NET, PLAYER, type StockKey } from "@ahb/data";
import { PlayerMotor, createPhysicsWorld, initPhysics, type MoveSample, type Rapier } from "@ahb/simulation";
import { Decoder, Encoder } from "@colyseus/schema";
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
const PLAYER_WALK = PLAYER.walkSpeed;

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

  it("lets a reconciling client land exactly on its own prediction, even sliding along walls", () => {
    const { k, state, client } = setup();
    // The client's reconcile: reset a motor to the decoded patch, replay what is unacknowledged.
    const replay = new PlayerMotor(createPhysicsWorld(R, DT), { x: 0, y: 0, z: 0 });
    const encoder = new Encoder(state);
    // Forward with a wide sweep of the view: the walk runs into counters and slides along them.
    const samples: MoveSample[] = [];
    for (let i = 0; i < 900; i++) {
      const t = i / NET.tickHz;
      samples.push({ seq: i + 1, mx: Math.sin(t * 0.9) * 0.4, mz: 1, yaw: Math.PI + Math.sin(t * 0.5) * 2.2, pitch: 0, buttons: i % 300 < 150 ? 2 : 0 });
    }
    const inflight: { at: number; smp: MoveSample }[] = [];
    let sent = 0;
    let worst = 0;
    let slid = 0;
    for (let tick = 0; tick < samples.length + 60; tick++) {
      if (sent < samples.length) {
        const smp = samples[sent++]!;
        const before = { ...client.state };
        const m = client.step(smp, DT, 1);
        const wanted = Math.hypot(m.vx, m.vz) > 0 ? 1 : 0;
        if (wanted && Math.hypot(m.x - before.x, m.z - before.z) < 0.9 * PLAYER_WALK * DT) slid++;
        inflight.push({ at: tick + 14 + (tick % 7), smp });
      }
      while (inflight.length && inflight[0]!.at <= tick) k.pushInput("p1", { samples: [inflight.shift()!.smp] } as never);
      k.step(DT);
      if (tick % 3 !== 0) continue;
      const decoded = new RestaurantState();
      new Decoder(decoded).decode(encoder.encodeAll());
      const ps = decoded.players.get("p1")!;
      replay.reset({ x: ps.x, y: ps.y, z: ps.z, vx: ps.vx, vy: ps.vy, vz: ps.vz, grounded: ps.grounded });
      for (const smp of samples.slice(ps.ack, sent)) replay.step(smp, DT, 1);
      const c = client.state;
      const r = replay.state;
      worst = Math.max(worst, Math.hypot(r.x - c.x, r.y - c.y, r.z - c.z));
    }
    expect(slid).toBeGreaterThan(30); // the walk really did scrape along geometry
    expect(worst).toBeLessThan(1e-9);
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
