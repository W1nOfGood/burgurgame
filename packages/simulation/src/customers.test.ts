import { describe, expect, it } from "vitest";
import { BOXES, COUNTER_SPOTS, CUSTOMER, CUSTOMER_PATH, NET, PICKUP_POINT } from "@ahb/data";
import { collectRoute, collectTicks, customerPose, inboundRoute, outboundRoute, phaseTicks, sampleRoute, walkTicks, type CustomerTimeline } from "./customers.js";

/** Floor footprints customers must keep clear of: collidable boxes plus the dining chairs. */
function obstacles(): { minX: number; maxX: number; minZ: number; maxZ: number }[] {
  // Collidable boxes that reach below head height (the door header hangs at 2.5 m); the
  // storefront itself is crossed through the door opening, checked separately.
  const low = (b: (typeof BOXES)[number]) => b.center[1] - b.half[1] < 1.8;
  const out = BOXES.filter((b) => b.collide && low(b) && b.id !== "floor" && !b.id.startsWith("wall_") && !b.id.startsWith("window_") && b.id !== "front_door").map((b) => ({
    minX: b.center[0] - b.half[0],
    maxX: b.center[0] + b.half[0],
    minZ: b.center[2] - b.half[2],
    maxZ: b.center[2] + b.half[2],
  }));
  // Chairs either side of each table (dining.py), ~0.46 m square.
  for (const id of ["table_1", "table_2", "table_3"]) {
    const t = BOXES.find((b) => b.id === id)!;
    for (const dx of [-0.66, 0.66]) {
      const cx = t.center[0] + dx;
      out.push({ minX: cx - 0.23, maxX: cx + 0.23, minZ: t.center[2] - 0.23, maxZ: t.center[2] + 0.23 });
    }
  }
  return out;
}

function clearance(x: number, z: number): number {
  let best = Infinity;
  for (const r of obstacles()) {
    const dx = Math.max(r.minX - x, 0, x - r.maxX);
    const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

describe("customer routes", () => {
  it("start on the street, come through the door and end at their counter spot", () => {
    COUNTER_SPOTS.forEach((spot, i) => {
      for (const seed of [0, 1, 2, 3]) {
        const r = inboundRoute(i, seed);
        const start = sampleRoute(r, 0);
        const end = sampleRoute(r, r.length);
        expect(Math.abs(start.x)).toBeCloseTo(7.6, 5);
        expect(start.z).toBeLessThan(-8);
        expect(end.x).toBeCloseTo(spot[0], 5);
        expect(end.z).toBeCloseTo(spot[1], 5);
        // Crosses the storefront line inside the door opening.
        let crossed = false;
        for (let d = 0; d < r.length; d += 0.02) {
          const a = sampleRoute(r, d);
          const b = sampleRoute(r, d + 0.02);
          if (a.z < -6.1 && b.z >= -6.1) {
            crossed = true;
            expect(Math.abs(a.x)).toBeLessThan(0.75);
          }
        }
        expect(crossed).toBe(true);
      }
    });
  });

  it("keep a body's width clear of tables, chairs and the counter", () => {
    for (let i = 0; i < COUNTER_SPOTS.length; i++) {
      for (const r of [inboundRoute(i, 1), outboundRoute(i, 2, true), outboundRoute(i, 0, false), collectRoute(i)]) {
        for (let d = 0; d <= r.length; d += 0.05) {
          const p = sampleRoute(r, d);
          if (p.z < -6.1) continue; // outside
          expect(clearance(p.x, p.z), `spot ${i} at ${p.x.toFixed(2)}, ${p.z.toFixed(2)}`).toBeGreaterThan(0.22);
        }
      }
    }
  });

  it("serve and leave from the pickup shelf", () => {
    const r = collectRoute(3);
    expect(sampleRoute(r, r.length).x).toBeCloseTo(PICKUP_POINT[0], 5);
    const out = outboundRoute(3, 0, true);
    expect(sampleRoute(out, 0).z).toBeCloseTo(PICKUP_POINT[1], 5);
    expect(sampleRoute(out, out.length).z).toBeLessThan(-8);
    expect(CUSTOMER_PATH.laneX).toBeGreaterThan(1);
  });
});

describe("customer poses", () => {
  const base: CustomerTimeline = { phase: "arriving", phaseAt: 1000, spot: 2, seed: 5, angry: false };

  it("walk the inbound route at walking speed, then face the counter", () => {
    const r = inboundRoute(base.spot, base.seed);
    const ticks = phaseTicks(base);
    expect(ticks).toBe(walkTicks(r));
    const mid = customerPose(base, 1000 + NET.tickHz * 2);
    expect(mid.speed).toBe(CUSTOMER.walkSpeed);
    expect(mid.walked).toBeCloseTo(CUSTOMER.walkSpeed * 2, 6);
    const end = customerPose(base, 1000 + ticks + 5);
    expect(end.speed).toBe(0);
    expect(end.yaw).toBe(0);
    expect(end.x).toBeCloseTo(COUNTER_SPOTS[2]![0], 5);
  });

  it("reach for the food at the shelf and carry it away", () => {
    const c: CustomerTimeline = { ...base, phase: "collecting" };
    const { handover, done } = collectTicks(c.spot);
    expect(phaseTicks(c)).toBe(done);
    expect(customerPose(c, 1000 + handover - 2).carrying).toBe(false);
    expect(customerPose(c, 1000 + handover - 2).reach).toBeGreaterThan(0.9);
    expect(customerPose(c, 1000 + handover + 1).carrying).toBe(true);
    const leaving = customerPose({ ...base, phase: "leaving" }, 1000 + 30);
    expect(leaving.carrying).toBe(true);
    const angry = customerPose({ ...base, phase: "leaving", angry: true }, 1000 + 30);
    expect(angry.carrying).toBe(false);
    expect(angry.speed).toBe(CUSTOMER.angrySpeed);
  });
});
