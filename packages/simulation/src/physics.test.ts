import { describe, expect, it } from "vitest";
import { GRILL_ZONES, PICKUP_ZONE } from "@ahb/data";
import { eyePosition, grillZoneAt, hasLineOfSight, inPickupZone, surfaceAt } from "./interaction.js";
import { PlayerMotor, type MoveSample } from "./movement.js";
import { createPhysicsWorld, initPhysics } from "./physics.js";
import { canAddToStack, stackOffsets } from "./stack.js";

const sample = (seq: number, mz: number, yaw = 0): MoveSample => ({ seq, mx: 0, mz, yaw, pitch: 0, buttons: 0 });

describe("rapier world (node init path)", () => {
  it("initialises the pinned Rapier build and moves a player", async () => {
    const R = await initPhysics();
    const pw = createPhysicsWorld(R);
    const motor = new PlayerMotor(pw, { x: 1.65, y: 0, z: 3.0 });
    for (let i = 0; i < 60; i++) motor.step(sample(i, 0, 0), 1 / 60);
    expect(motor.state.y).toBeCloseTo(0, 1);
    // Walk backwards (toward -Z) for one second.
    for (let i = 0; i < 60; i++) motor.step(sample(i, -1, 0), 1 / 60);
    expect(motor.state.z).toBeLessThan(1.2);
    expect(motor.state.z).toBeGreaterThan(0.3);
    pw.dispose();
  });

  it("stops the player at the grill", async () => {
    const R = await initPhysics();
    const pw = createPhysicsWorld(R);
    const motor = new PlayerMotor(pw, { x: 0, y: 0, z: 3.4 });
    for (let i = 0; i < 180; i++) motor.step(sample(i, 1, 0), 1 / 60);
    // Grill front face is at z = 4.15; capsule radius 0.3.
    expect(motor.state.z).toBeLessThan(4.15 - 0.25);
    pw.dispose();
  });

  it("produces identical trajectories in two worlds (prediction parity)", async () => {
    const R = await initPhysics();
    const a = createPhysicsWorld(R);
    const b = createPhysicsWorld(R);
    const ma = new PlayerMotor(a, { x: 0.6, y: 0, z: 3.3 });
    const mb = new PlayerMotor(b, { x: 0.6, y: 0, z: 3.3 });
    for (let i = 0; i < 240; i++) {
      const s = { seq: i, mx: Math.sin(i / 20), mz: 1, yaw: i / 50, pitch: 0, buttons: i % 90 < 45 ? 1 : 0 };
      ma.step(s, 1 / 60);
      mb.step(s, 1 / 60);
    }
    expect(ma.state.x).toBe(mb.state.x);
    expect(ma.state.z).toBe(mb.state.z);
    a.dispose();
    b.dispose();
  });

  it("blocks line of sight through the front counter", async () => {
    const R = await initPhysics();
    const pw = createPhysicsWorld(R);
    const eye = eyePosition({ x: 0, y: 0, z: -1.2 }, false);
    // A point inside the counter's lower cabinet, below the top surface, is blocked.
    expect(hasLineOfSight(pw.castStatic, eye, { x: 0, y: 0.5, z: 0.6 })).toBe(false);
    // A point resting on the counter top is visible.
    expect(hasLineOfSight(pw.castStatic, eye, { x: 0, y: 1.0, z: -0.1 })).toBe(true);
    pw.dispose();
  });
});

describe("placement rules", () => {
  it("finds grill zones and surfaces", () => {
    const zone = GRILL_ZONES[1]!;
    expect(grillZoneAt(0, zone.y, 4.5)).toBe(1);
    expect(surfaceAt({ x: 0, y: 0.9, z: 4.5 })?.kind).toBe("grill");
    expect(surfaceAt({ x: 0, y: 0.92, z: 2.2 })?.kind).toBe("counter");
    expect(inPickupZone({ x: -0.4, y: PICKUP_ZONE.y, z: 0 })).toBe(true);
    expect(surfaceAt({ x: -0.4, y: 1.0, z: 0 })?.kind).toBe("pickup");
    expect(surfaceAt({ x: 0, y: 0.5, z: 2.2 })).toBeNull();
  });

  it("enforces burger stacking rules", () => {
    expect(canAddToStack(["tray"], "bun_bottom").ok).toBe(true);
    expect(canAddToStack(["tray"], "patty").ok).toBe(false);
    expect(canAddToStack(["tray", "bun_bottom", "patty"], "cheese").ok).toBe(true);
    expect(canAddToStack(["tray", "bun_bottom", "bun_top"], "cheese").ok).toBe(false);
    expect(canAddToStack(["spatula"], "patty").ok).toBe(true);
    expect(canAddToStack(["spatula", "patty"], "patty").ok).toBe(false);
  });

  it("computes stack offsets above the root", () => {
    const o = stackOffsets(["tray", "bun_bottom", "patty"]);
    expect(o[0]).toBe(0);
    expect(o[1]).toBeCloseTo(0.01 + 0.016, 5);
    expect(o[2]).toBeCloseTo(0.01 + 0.032 + 0.012, 5);
  });
});
