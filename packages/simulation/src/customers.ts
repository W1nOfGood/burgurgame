import { COUNTER_FACING_YAW, COUNTER_SPOTS, CUSTOMER, CUSTOMER_PATH, NET, PICKUP_POINT, type XZ } from "@ahb/data";

/**
 * Customer walk timelines. The server only replicates a customer's phase, the tick it started
 * and the counter spot; both sides rebuild the same routes from data/customers.ts and evaluate
 * poses from them, so walking customers cost no per-tick network traffic.
 */

export type CustomerPhase = "arriving" | "ordering" | "waiting" | "collecting" | "leaving";

export interface CustomerTimeline {
  phase: CustomerPhase;
  /** Server tick at which the phase started. */
  phaseAt: number;
  spot: number;
  seed: number;
  /** Leaving without food (gave up waiting). */
  angry: boolean;
}

export interface Route {
  pts: XZ[];
  /** Cumulative length at each point. */
  cum: number[];
  length: number;
}

export interface CustomerPose {
  x: number;
  z: number;
  /** Facing; yaw 0 looks toward +Z. */
  yaw: number;
  /** Metres per second along the path (0 when standing). */
  speed: number;
  /** Distance walked along the current route, metres (drives the stride phase). */
  walked: number;
  /** 0..1 reach toward the pickup shelf. */
  reach: number;
  /** Carrying their order away. */
  carrying: boolean;
}

function chaikin(pts: XZ[], passes: number): XZ[] {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    if (p.length < 3) return p;
    const out: XZ[] = [p[0]!];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i]!;
      const [bx, bz] = p[i + 1]!;
      if (i > 0) out.push([0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz]);
      if (i < p.length - 2) out.push([0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz]);
    }
    out.push(p[p.length - 1]!);
    p = out;
  }
  return p;
}

/** A polyline with rounded corners (end points kept). */
export function makeRoute(points: XZ[], smoothing: number = CUSTOMER.smoothing): Route {
  const pts = chaikin(points, smoothing);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1]!;
    const [bx, bz] = pts[i]!;
    cum.push(cum[i - 1]! + Math.hypot(bx - ax, bz - az));
  }
  return { pts, cum, length: cum[cum.length - 1]! };
}

/** Position and heading at `dist` metres along the route (clamped to its ends). */
export function sampleRoute(r: Route, dist: number): { x: number; z: number; yaw: number } {
  const d = Math.max(0, Math.min(r.length, dist));
  let i = 1;
  while (i < r.pts.length - 1 && r.cum[i]! < d) i++;
  const [ax, az] = r.pts[i - 1]!;
  const [bx, bz] = r.pts[i]!;
  const seg = r.cum[i]! - r.cum[i - 1]!;
  const t = seg > 1e-9 ? (d - r.cum[i - 1]!) / seg : 1;
  return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, yaw: Math.atan2(bx - ax, bz - az) };
}

function spotXZ(spot: number): XZ {
  return COUNTER_SPOTS[Math.max(0, Math.min(COUNTER_SPOTS.length - 1, spot))]!;
}

function laneFor(x: number): number {
  return x <= 0.05 ? -CUSTOMER_PATH.laneX : CUSTOMER_PATH.laneX;
}

const entrySide = (seed: number): -1 | 1 => (seed & 1 ? 1 : -1);
const exitSide = (seed: number): -1 | 1 => (seed & 2 ? 1 : -1);

/** Street → door → lane between the tables → counter spot. */
export function inboundRoute(spot: number, seed: number): Route {
  const side = entrySide(seed);
  const s = spotXZ(spot);
  const lane = laneFor(s[0]);
  const P = CUSTOMER_PATH;
  return makeRoute([P.street(side), P.kerb(side), P.outside, P.inside, [lane, P.laneTop], [lane, P.laneBottom], s]);
}

/** Counter spot → the pickup shelf. */
export function collectRoute(spot: number): Route {
  return makeRoute([spotXZ(spot), PICKUP_POINT], 0);
}

/** From the spot (or the pickup shelf) back out to the street. */
export function outboundRoute(spot: number, seed: number, fromPickup: boolean): Route {
  const side = exitSide(seed);
  const s = spotXZ(spot);
  const start = fromPickup ? PICKUP_POINT : s;
  const lane = laneFor(s[0]);
  const P = CUSTOMER_PATH;
  const back: XZ = [start[0], start[1] - 0.45];
  return makeRoute([start, back, [lane, P.laneBottom], [lane, P.laneTop], P.inside, P.outside, P.kerb(side), P.street(side)]);
}

export function ticksFor(seconds: number): number {
  return Math.ceil(seconds * NET.tickHz);
}

export function walkTicks(r: Route, angry = false): number {
  return ticksFor(r.length / (angry ? CUSTOMER.angrySpeed : CUSTOMER.walkSpeed));
}

/** Ticks from the start of "collecting" until the food leaves the tray, and until they turn to go. */
export function collectTicks(spot: number): { handover: number; done: number } {
  const walk = walkTicks(collectRoute(spot));
  return { handover: walk + ticksFor(CUSTOMER.handoverAt), done: walk + ticksFor(CUSTOMER.collectSeconds) };
}

/** Ticks a phase lasts on its own (waiting has no end of its own). */
export function phaseTicks(c: CustomerTimeline): number {
  switch (c.phase) {
    case "arriving":
      return walkTicks(inboundRoute(c.spot, c.seed));
    case "collecting":
      return collectTicks(c.spot).done;
    case "leaving":
      return walkTicks(outboundRoute(c.spot, c.seed, !c.angry), c.angry);
    default:
      return Infinity;
  }
}

/** Where a customer is at `tick` (fractional ticks allowed, for rendering). */
export function customerPose(c: CustomerTimeline, tick: number): CustomerPose {
  const t = Math.max(0, (tick - c.phaseAt) / NET.tickHz);
  const at = (r: Route, speed: number, carrying: boolean): CustomerPose => {
    const walked = t * speed;
    const p = sampleRoute(r, walked);
    const moving = walked < r.length;
    return { x: p.x, z: p.z, yaw: p.yaw, speed: moving ? speed : 0, walked: Math.min(walked, r.length), reach: 0, carrying };
  };
  switch (c.phase) {
    case "arriving": {
      const pose = at(inboundRoute(c.spot, c.seed), CUSTOMER.walkSpeed, false);
      if (pose.speed === 0) pose.yaw = COUNTER_FACING_YAW;
      return pose;
    }
    case "collecting": {
      const r = collectRoute(c.spot);
      const pose = at(r, CUSTOMER.walkSpeed, false);
      const stand = t - r.length / CUSTOMER.walkSpeed;
      if (stand >= 0) {
        pose.yaw = COUNTER_FACING_YAW;
        const h = CUSTOMER.handoverAt;
        // Reach in, take the food at the handover moment, draw it back.
        pose.reach = stand < h ? Math.min(1, stand / h) : Math.max(0, 1 - (stand - h) / (CUSTOMER.collectSeconds - h));
        pose.carrying = stand >= h;
      }
      return pose;
    }
    case "leaving":
      return at(outboundRoute(c.spot, c.seed, !c.angry), c.angry ? CUSTOMER.angrySpeed : CUSTOMER.walkSpeed, !c.angry);
    default: {
      const [x, z] = spotXZ(c.spot);
      return { x, z, yaw: COUNTER_FACING_YAW, speed: 0, walked: 0, reach: 0, carrying: false };
    }
  }
}
