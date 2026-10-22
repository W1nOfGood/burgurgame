import RAPIER from "@dimforge/rapier3d-compat";
import { BOXES } from "@ahb/data";
import type { StaticRaycast } from "./interaction.js";
import type { V3 } from "./vec.js";

export type Rapier = typeof RAPIER;

let ready: Promise<Rapier> | null = null;

/** Initialises the pinned Rapier WASM build. Safe to call repeatedly. */
export function initPhysics(): Promise<Rapier> {
  ready ??= RAPIER.init().then(() => RAPIER);
  return ready;
}

/** Collision group bits. Players only collide with static geometry (see docs/ARCHITECTURE.md). */
export const GROUP_STATIC = 0x0001;
export const GROUP_PLAYER = 0x0002;
export const GROUP_ITEM = 0x0004;

export function groups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export const STATIC_GROUPS = groups(GROUP_STATIC, 0xffff);
export const PLAYER_GROUPS = groups(GROUP_PLAYER, GROUP_STATIC);
export const ITEM_GROUPS = groups(GROUP_ITEM, GROUP_STATIC | GROUP_ITEM);
/** Query filter that only hits static restaurant geometry. */
export const QUERY_STATIC = groups(0xffff, GROUP_STATIC);
/** Query filter that only hits items. */
export const QUERY_ITEMS = groups(0xffff, GROUP_ITEM);

export interface PhysicsWorld {
  R: Rapier;
  world: InstanceType<Rapier["World"]>;
  castStatic: StaticRaycast;
  dispose(): void;
}

/**
 * Builds a Rapier world containing the restaurant's static collision boxes. Used by the server
 * (authoritative) and by the client for local movement prediction.
 */
export function createPhysicsWorld(R: Rapier, timestep = 1 / 60): PhysicsWorld {
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = timestep;
  for (const box of BOXES) {
    if (!box.collide) continue;
    const desc = R.ColliderDesc.cuboid(box.half[0], box.half[1], box.half[2])
      .setTranslation(box.center[0], box.center[1], box.center[2])
      .setCollisionGroups(STATIC_GROUPS)
      .setFriction(0.8);
    world.createCollider(desc);
  }
  // One step populates the broad phase so scene queries and the character controller see the
  // static geometry before the first real simulation step.
  world.step();

  const castStatic: StaticRaycast = (from: V3, dir: V3, maxDistance: number) => {
    const ray = new R.Ray(from, dir);
    const hit = world.castRay(ray, maxDistance, true, undefined, QUERY_STATIC);
    return hit ? hit.timeOfImpact : null;
  };

  return {
    R,
    world,
    castStatic,
    dispose: () => world.free(),
  };
}
