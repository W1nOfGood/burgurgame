import type { ItemKind } from "./items.js";

/**
 * Restaurant layout in metres. +Y is up, the kitchen is toward +Z, the dining room and street
 * toward -Z. Yaw 0 looks toward +Z.
 *
 * The same boxes feed server collision, client prediction and the client's early-layout
 * geometry, so the three never disagree. Visual hero meshes replace the boxes in Stage 3, but
 * collision keeps using these simplified shapes.
 */
export type Vec3 = readonly [number, number, number];

export type MaterialId =
  | "floor_tile"
  | "wall_plaster"
  | "wall_tile"
  | "stainless"
  | "grill_plate"
  | "laminate"
  | "timber"
  | "glass"
  | "dark_metal"
  | "ceiling"
  | "fridge_white"
  | "red_vinyl"
  | "street";

export type SurfaceKind = "counter" | "grill" | "pickup" | "floor";

export interface LayoutBox {
  id: string;
  center: Vec3;
  half: Vec3;
  material: MaterialId;
  /** Present in the physics world. */
  collide: boolean;
  /** The box's top face is a placement surface of this kind. */
  surface?: SurfaceKind;
}

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface GrillZone {
  id: number;
  rect: Rect;
  y: number;
  knob: Vec3;
}

export interface Dispenser {
  id: string;
  kind: ItemKind;
  /** Centre of the bin opening; players target this to take an item. */
  center: Vec3;
  half: Vec3;
  /** Requires the chiller drawer to be open past this amount. */
  requiresDrawer?: number;
}

export interface Drawer {
  id: string;
  /** Closed handle position. The drawer slides toward -Z when opened. */
  handle: Vec3;
  travel: number;
  half: Vec3;
}

export const ROOM_BOUNDS = { minX: -6, maxX: 6, minZ: -6, maxZ: 5, height: 3.2 } as const;

const WALL_H = 1.6;

export const BOXES: readonly LayoutBox[] = [
  // Shell
  { id: "floor", center: [0, -0.1, -0.5], half: [6.2, 0.1, 5.7], material: "floor_tile", collide: true, surface: "floor" },
  { id: "ceiling", center: [0, 3.25, -0.5], half: [6.2, 0.05, 5.7], material: "ceiling", collide: false },
  { id: "wall_north", center: [0, WALL_H, 5.1], half: [6.2, WALL_H, 0.1], material: "wall_tile", collide: true },
  { id: "wall_west", center: [-6.1, WALL_H, -0.5], half: [0.1, WALL_H, 5.7], material: "wall_plaster", collide: true },
  { id: "wall_east", center: [6.1, WALL_H, -0.5], half: [0.1, WALL_H, 5.7], material: "wall_plaster", collide: true },
  { id: "wall_south_left", center: [-3.6, WALL_H, -6.1], half: [2.6, WALL_H, 0.1], material: "wall_plaster", collide: true },
  { id: "wall_south_right", center: [3.6, WALL_H, -6.1], half: [2.6, WALL_H, 0.1], material: "wall_plaster", collide: true },
  { id: "door_header", center: [0, 2.85, -6.1], half: [1.0, 0.35, 0.1], material: "wall_plaster", collide: true },
  { id: "front_door", center: [0, 1.25, -6.1], half: [1.0, 1.25, 0.04], material: "glass", collide: true },

  // Front counter with a 1.2 m passage between x = 2.8 and x = 4.0
  { id: "counter_front_a", center: [-1.6, 0.5, 0], half: [4.4, 0.5, 0.35], material: "laminate", collide: true, surface: "counter" },
  { id: "counter_front_b", center: [5.0, 0.5, 0], half: [1.0, 0.5, 0.35], material: "laminate", collide: true, surface: "counter" },
  { id: "register", center: [-3.5, 1.12, 0], half: [0.2, 0.12, 0.18], material: "dark_metal", collide: true },
  { id: "heat_lamp", center: [-0.4, 1.68, 0], half: [1.05, 0.04, 0.2], material: "stainless", collide: false },
  { id: "ticket_rail", center: [-0.4, 1.78, 0.32], half: [1.05, 0.015, 0.02], material: "stainless", collide: false },

  // Cook line along the north wall
  { id: "grill", center: [0, 0.45, 4.55], half: [0.85, 0.45, 0.4], material: "grill_plate", collide: true, surface: "grill" },
  { id: "grill_hood", center: [0, 2.45, 4.6], half: [1.05, 0.3, 0.45], material: "stainless", collide: false },
  { id: "prep_counter", center: [-2.6, 0.46, 4.6], half: [1.5, 0.46, 0.35], material: "stainless", collide: true, surface: "counter" },
  { id: "fryer", center: [1.5, 0.45, 4.6], half: [0.4, 0.45, 0.35], material: "stainless", collide: true },
  { id: "walk_in", center: [-5.4, 1.0, 4.5], half: [0.55, 1.0, 0.45], material: "fridge_white", collide: true },
  { id: "dry_storage", center: [3.6, 0.9, 4.75], half: [0.9, 0.9, 0.2], material: "dark_metal", collide: true },
  { id: "office_desk", center: [5.1, 0.38, 4.4], half: [0.8, 0.38, 0.5], material: "timber", collide: true, surface: "counter" },

  // Assembly island, sink, trash, drinks
  { id: "assembly_island", center: [-0.5, 0.46, 2.2], half: [1.7, 0.46, 0.4], material: "stainless", collide: true, surface: "counter" },
  { id: "sink", center: [-5.6, 0.46, 2.2], half: [0.4, 0.46, 0.6], material: "stainless", collide: true },
  { id: "trash", center: [2.4, 0.4, 2.2], half: [0.22, 0.4, 0.22], material: "dark_metal", collide: true },
  { id: "drinks", center: [5.0, 0.5, 1.0], half: [0.9, 0.5, 0.35], material: "stainless", collide: true },

  // Dining room
  { id: "table_1", center: [-3.5, 0.37, -3.0], half: [0.45, 0.37, 0.45], material: "timber", collide: true, surface: "counter" },
  { id: "table_2", center: [0, 0.37, -3.8], half: [0.45, 0.37, 0.45], material: "timber", collide: true, surface: "counter" },
  { id: "table_3", center: [3.5, 0.37, -3.0], half: [0.45, 0.37, 0.45], material: "timber", collide: true, surface: "counter" },
  { id: "booth_west", center: [-5.6, 0.25, -3.0], half: [0.35, 0.25, 1.2], material: "red_vinyl", collide: true },

  // Street strip outside the storefront (visual only)
  { id: "sidewalk", center: [0, -0.12, -8.0], half: [8.0, 0.1, 1.8], material: "street", collide: false },
];

export const GRILL_TOP_Y = 0.9;

export const GRILL_ZONES: readonly GrillZone[] = [
  { id: 0, rect: { minX: -0.78, maxX: -0.26, minZ: 4.2, maxZ: 4.9 }, y: GRILL_TOP_Y, knob: [-0.52, 0.76, 4.13] },
  { id: 1, rect: { minX: -0.26, maxX: 0.26, minZ: 4.2, maxZ: 4.9 }, y: GRILL_TOP_Y, knob: [0, 0.76, 4.13] },
  { id: 2, rect: { minX: 0.26, maxX: 0.78, minZ: 4.2, maxZ: 4.9 }, y: GRILL_TOP_Y, knob: [0.52, 0.76, 4.13] },
];

/** Placing a tray here hands the order to the customer. */
export const PICKUP_ZONE: Rect & { y: number } = { minX: -1.4, maxX: 0.6, minZ: -0.33, maxZ: 0.33, y: 1.0 };

/** Items released over this volume are disposed of (and counted as waste if food). */
export const TRASH_ZONE: Rect & { minY: number; maxY: number } = {
  minX: 2.15,
  maxX: 2.65,
  minZ: 1.95,
  maxZ: 2.45,
  minY: 0.6,
  maxY: 1.4,
};

export const CHILLER_DRAWER: Drawer = {
  id: "chiller",
  handle: [-1.6, 0.62, 4.23],
  travel: 0.42,
  half: [0.42, 0.14, 0.3],
};

const PREP_TOP = 0.92;

export const DISPENSERS: readonly Dispenser[] = [
  { id: "bin_bun_bottom", kind: "bun_bottom", center: [-3.85, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_bun_top", kind: "bun_top", center: [-3.45, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_cheese", kind: "cheese", center: [-3.02, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_lettuce", kind: "lettuce", center: [-2.6, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_tomato", kind: "tomato", center: [-2.18, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_onion", kind: "onion", center: [-1.76, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_pickle", kind: "pickle", center: [-1.34, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  // Patties live in the chiller drawer under the prep counter. The centre is the drawer's
  // fully open position; it is only reachable when the drawer is open.
  { id: "drawer_patty", kind: "patty", center: [-1.6, 0.66, 3.95], half: [0.38, 0.06, 0.24], requiresDrawer: 0.55 },
  { id: "tray_stack", kind: "tray", center: [-1.95, 0.95, 2.2], half: [0.22, 0.05, 0.17] },
];

/** Areas where placement is refused even though they sit on a surface (bin openings). */
export const NO_PLACE_RECTS: readonly (Rect & { y: number })[] = [
  { minX: -4.05, maxX: -1.15, minZ: 4.5, maxZ: 4.95, y: PREP_TOP },
];

export const SHIFT_SWITCH: Vec3 = [2.62, 0.9, 0.37];

export interface InitialItem {
  kind: ItemKind;
  position: Vec3;
  yaw?: number;
}

export const INITIAL_ITEMS: readonly InitialItem[] = [
  { kind: "spatula", position: [1.0, 0.94, 2.35], yaw: Math.PI / 2 },
  { kind: "sauce_bottle", position: [0.7, 1.01, 2.05] },
  { kind: "tray", position: [-0.9, 0.93, 2.2] },
  { kind: "tray", position: [-0.2, 0.93, 2.2] },
];

export const SPAWN_POINTS: readonly Vec3[] = [
  [-1.0, 0, 3.3],
  [0.6, 0, 3.3],
  [-1.2, 0, 1.0],
  [0.8, 0, 1.0],
];

/** Yaw for new players: facing the grill. */
export const SPAWN_YAW = 0;

export function inRect(rect: Rect, x: number, z: number): boolean {
  return x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
}

export function surfaceBoxes(): LayoutBox[] {
  return BOXES.filter((b) => b.surface !== undefined);
}
