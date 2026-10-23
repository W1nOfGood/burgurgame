import {
  BOXES,
  DISPENSERS,
  GRILL_ZONES,
  INTERACTION,
  NO_PLACE_RECTS,
  PICKUP_ZONE,
  PLAYER,
  TRASH_ZONE,
  inRect,
  type Dispenser,
  type SurfaceKind,
} from "@ahb/data";
import { distance, type V3 } from "./vec.js";

export function eyePosition(feet: V3, crouching: boolean): V3 {
  return { x: feet.x, y: feet.y + (crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight), z: feet.z };
}

/** Server-side reach check, including the latency allowance. */
export function withinReach(eye: V3, point: V3, extra = 0): boolean {
  return distance(eye, point) <= INTERACTION.reach + INTERACTION.reachTolerance + extra;
}

/** Returns distance to the first static obstacle along the ray, or null. */
export type StaticRaycast = (from: V3, dir: V3, maxDistance: number) => number | null;

/** True when nothing static blocks the straight line between eye and point. */
export function hasLineOfSight(cast: StaticRaycast, eye: V3, point: V3, slack = 0.04): boolean {
  const d = distance(eye, point);
  if (d < 1e-6) return true;
  const dir = { x: (point.x - eye.x) / d, y: (point.y - eye.y) / d, z: (point.z - eye.z) / d };
  const hit = cast(eye, dir, d);
  return hit === null || hit >= d - slack;
}

export interface SurfaceHit {
  boxId: string;
  kind: SurfaceKind;
  y: number;
}

/** Finds the placement surface whose top face contains the point (within tolerance). */
export function surfaceAt(point: V3, tolerance: number = INTERACTION.surfaceTolerance): SurfaceHit | null {
  let best: SurfaceHit | null = null;
  for (const box of BOXES) {
    if (!box.surface) continue;
    const top = box.center[1] + box.half[1];
    if (Math.abs(point.y - top) > tolerance) continue;
    const margin = 0.01;
    if (Math.abs(point.x - box.center[0]) > box.half[0] - margin) continue;
    if (Math.abs(point.z - box.center[2]) > box.half[2] - margin) continue;
    if (!best || top > best.y) best = { boxId: box.id, kind: inPickupZone(point) ? "pickup" : box.surface, y: top };
  }
  return best;
}

export function isNoPlaceArea(point: V3): boolean {
  return NO_PLACE_RECTS.some((r) => Math.abs(point.y - r.y) < 0.1 && inRect(r, point.x, point.z));
}

/** Grill zone id containing a point on the grill top, or -1. */
export function grillZoneAt(x: number, y: number, z: number, tolerance = 0.06): number {
  for (const zone of GRILL_ZONES) {
    if (Math.abs(y - zone.y) <= tolerance && inRect(zone.rect, x, z)) return zone.id;
  }
  return -1;
}

export function inPickupZone(point: V3): boolean {
  return Math.abs(point.y - PICKUP_ZONE.y) < 0.12 && inRect(PICKUP_ZONE, point.x, point.z);
}

export function inTrashZone(point: V3): boolean {
  return point.y >= TRASH_ZONE.minY && point.y <= TRASH_ZONE.maxY && inRect(TRASH_ZONE, point.x, point.z);
}

/** Dispenser whose opening contains the point. `drawerOpen` gates the chiller drawer. */
export function dispenserAt(point: V3, drawerOpen: number, slack = 0.05): Dispenser | null {
  for (const d of DISPENSERS) {
    if (d.requiresDrawer !== undefined && drawerOpen < d.requiresDrawer) continue;
    if (
      Math.abs(point.x - d.center[0]) <= d.half[0] + slack &&
      Math.abs(point.y - d.center[1]) <= d.half[1] + slack + 0.05 &&
      Math.abs(point.z - d.center[2]) <= d.half[2] + slack
    ) {
      return d;
    }
  }
  return null;
}

export function dispenserById(id: string): Dispenser | null {
  return DISPENSERS.find((d) => d.id === id) ?? null;
}
