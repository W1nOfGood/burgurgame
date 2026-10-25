import type { ItemKind } from "./items.js";
import { DRINKS_ENABLED } from "./drinks.js";

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
  // Storefront: low wall, window glass, header band on each side of the door.
  { id: "wall_south_left_low", center: [-3.6, 0.45, -6.1], half: [2.6, 0.45, 0.1], material: "wall_plaster", collide: true },
  { id: "window_left", center: [-3.6, 1.65, -6.1], half: [2.6, 0.75, 0.03], material: "glass", collide: true },
  { id: "wall_south_left_high", center: [-3.6, 2.8, -6.1], half: [2.6, 0.4, 0.1], material: "wall_plaster", collide: true },
  { id: "wall_south_right_low", center: [3.6, 0.45, -6.1], half: [2.6, 0.45, 0.1], material: "wall_plaster", collide: true },
  { id: "window_right", center: [3.6, 1.65, -6.1], half: [2.6, 0.75, 0.03], material: "glass", collide: true },
  { id: "wall_south_right_high", center: [3.6, 2.8, -6.1], half: [2.6, 0.4, 0.1], material: "wall_plaster", collide: true },
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
  // The monitor on the desk (pick target only: nothing collides with it).
  { id: "office_screen", center: [4.95, 1.08, 4.62], half: [0.29, 0.19, 0.03], material: "dark_metal", collide: false },

  // Assembly island, sink, trash, drinks
  { id: "assembly_island", center: [-0.5, 0.46, 2.2], half: [1.7, 0.46, 0.4], material: "stainless", collide: true, surface: "counter" },
  { id: "sink", center: [-5.6, 0.46, 2.2], half: [0.4, 0.46, 0.6], material: "stainless", collide: true },
  { id: "trash", center: [2.4, 0.4, 2.2], half: [0.22, 0.4, 0.22], material: "dark_metal", collide: true },
  { id: "drinks", center: [5.0, 0.5, 1.0], half: [0.9, 0.5, 0.35], material: "stainless", collide: true },
  // Drip tray and the strip in front of the fountain tower: cups stand here to fill.
  { id: "drink_station", center: [5.0, 1.015, 1.235], half: [0.88, 0.015, 0.115], material: "stainless", collide: true, surface: "counter" },

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

/** Cold rail along the back edge of the assembly island. */
const RAIL_Y = 0.92;
const RAIL_Z = 2.48;
const RAIL_HALF: Vec3 = [0.11, 0.05, 0.085];

export const DISPENSERS: readonly Dispenser[] = [
  // Prep counter, back row.
  { id: "bin_bun_bottom", kind: "bun_bottom", center: [-3.85, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_bun_top", kind: "bun_top", center: [-3.45, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_cheese", kind: "cheese", center: [-3.02, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_swiss", kind: "swiss", center: [-2.6, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_lettuce", kind: "lettuce", center: [-2.18, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_tomato", kind: "tomato", center: [-1.76, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  { id: "bin_onion", kind: "onion", center: [-1.34, PREP_TOP, 4.72], half: [0.17, 0.05, 0.2] },
  // Cold rail on the assembly island.
  { id: "bin_pickle", kind: "pickle", center: [-1.7, RAIL_Y, RAIL_Z], half: RAIL_HALF },
  { id: "bin_jalapeno", kind: "jalapeno", center: [-1.45, RAIL_Y, RAIL_Z], half: RAIL_HALF },
  { id: "bin_mushroom", kind: "mushroom", center: [-1.2, RAIL_Y, RAIL_Z], half: RAIL_HALF },
  { id: "bin_bacon", kind: "bacon", center: [-0.95, RAIL_Y, RAIL_Z], half: RAIL_HALF },
  { id: "bin_egg", kind: "egg", center: [-0.7, RAIL_Y, RAIL_Z], half: RAIL_HALF },
  // Beef and veggie patties live in the chiller drawer under the prep counter. Centres are the
  // drawer's fully open position; they are only reachable when the drawer is open.
  { id: "drawer_patty", kind: "patty", center: [-1.8, 0.66, 3.95], half: [0.18, 0.06, 0.24], requiresDrawer: 0.55 },
  { id: "drawer_veggie", kind: "veggie_patty", center: [-1.4, 0.66, 3.95], half: [0.18, 0.06, 0.24], requiresDrawer: 0.55 },
  { id: "tray_stack", kind: "tray", center: [-1.95, 0.95, 2.2], half: [0.22, 0.05, 0.17] },
  // Cup stacks either side of the fountain (sleeves on the cabinet top).
  ...(DRINKS_ENABLED
    ? ([
        { id: "cups_west", kind: "cup", center: [4.18, 1.21, 1.15], half: [0.06, 0.21, 0.06] },
        { id: "cups_east", kind: "cup", center: [5.82, 1.21, 1.15], half: [0.06, 0.21, 0.06] },
      ] as const)
    : []),
];

/** Areas where placement is refused even though they sit on a surface (bin openings). */
export const NO_PLACE_RECTS: readonly (Rect & { y: number })[] = [
  { minX: -4.05, maxX: -1.15, minZ: 4.5, maxZ: 4.95, y: PREP_TOP },
  { minX: -1.83, maxX: -0.57, minZ: 2.38, maxZ: 2.6, y: RAIL_Y },
];

export const SHIFT_SWITCH: Vec3 = [2.62, 0.9, 0.37];

/** The cash register: aim here to take a customer's order. */
export const REGISTER: Vec3 = [-3.5, 1.27, 0.08];

/** The office monitor: aim here to order supplies. */
export const OFFICE_COMPUTER: Vec3 = [4.95, 1.08, 4.62];

export interface InitialItem {
  kind: ItemKind;
  position: Vec3;
  yaw?: number;
}

export const INITIAL_ITEMS: readonly InitialItem[] = [
  { kind: "spatula", position: [1.0, 0.94, 2.42], yaw: Math.PI / 2 },
  { kind: "spatula", position: [0.6, 0.94, 2.45], yaw: Math.PI / 2 },
  // Sauce station on the front-right of the island.
  { kind: "ketchup_bottle", position: [0.3, 1.01, 1.98] },
  { kind: "mustard_bottle", position: [0.45, 1.01, 1.98] },
  { kind: "mayo_bottle", position: [0.6, 1.01, 1.98] },
  { kind: "bbq_bottle", position: [0.75, 1.01, 1.98] },
  { kind: "sauce_bottle", position: [0.9, 1.01, 1.98] },
  { kind: "tray", position: [-0.9, 0.93, 2.15] },
  { kind: "tray", position: [-0.2, 0.93, 2.15] },
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
