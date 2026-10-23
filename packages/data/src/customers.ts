/**
 * Walk-in customers (front of house). A customer comes in from the street, walks round the
 * dining tables to a free spot at the front counter and orders there: the ticket prints when
 * they arrive. When their burger goes on the pickup shelf they step over, take it and leave;
 * if they wait too long (normal mode) they leave without it.
 *
 * Positions are metres on the floor plane (x, z) of the layout in layout.ts. Server and client
 * derive every pose from these constants and a customer's phase start tick, so no per-tick
 * positions are replicated.
 */

export type XZ = readonly [number, number];

export const CUSTOMER = {
  /** Walking speed in m/s; customers who give up walk a little faster. */
  walkSpeed: 1.15,
  angrySpeed: 1.45,
  /** Seconds a served customer stands at the pickup shelf (reach, take, turn away). */
  collectSeconds: 1.8,
  /** Seconds into that stand when the food leaves the tray. */
  handoverAt: 0.8,
  /** Corner rounding passes applied to every route (Chaikin). */
  smoothing: 2,
} as const;

/** Spots in front of the counter, best first (nearest the pickup shelf under the heat lamp). */
export const COUNTER_SPOTS: readonly XZ[] = [
  [-0.4, -0.88],
  [0.5, -0.9],
  [-1.3, -0.9],
  [1.4, -0.92],
  [-2.2, -0.9],
  [2.25, -0.95],
  [-3.1, -0.92],
  [-4.0, -0.95],
];

/** Where a served customer stands to take the food from the pickup shelf. */
export const PICKUP_POINT: XZ = [-0.4, -0.64];

/** Customers face the counter (+Z) while they wait. */
export const COUNTER_FACING_YAW = 0;

/** Front door: the hinges are at x = ±0.95, the leaves swing out to the street (−Z). */
export const FRONT_DOOR = { z: -6.1, halfWidth: 0.95, openDistance: 1.4 } as const;

/** Waypoints between the street and the counter; lanes run between the dining tables. */
export const CUSTOMER_PATH = {
  /** Sidewalk ends, by side (−1 west, +1 east). */
  street: (side: -1 | 1): XZ => [side * 7.6, -8.7],
  kerb: (side: -1 | 1): XZ => [side * 0.7, -7.5],
  outside: [0, -6.7] as XZ,
  inside: [0, -5.5] as XZ,
  laneX: 1.75,
  laneTop: -4.9,
  laneBottom: -2.0,
};

/**
 * Customer looks (assets/source/blender/people.py builds one rigged model per look; the client
 * loads `customer_<id>.gltf`). Each look has its own pool of names, so a ticket's name always
 * fits the person who walked in with it.
 */
export interface CustomerLook {
  id: string;
  /** What they are wearing, for the stand-in body before the model loads (linear RGB). */
  top: [number, number, number];
  bottom: [number, number, number];
  skin: [number, number, number];
  names: readonly string[];
}

export const CUSTOMER_LOOKS: readonly CustomerLook[] = [
  { id: "student", top: [0.62, 0.42, 0.08], bottom: [0.12, 0.17, 0.3], skin: [0.62, 0.42, 0.3], names: ["Maya", "Zoe", "Priya", "Hana", "Freya", "Ava", "Lena"] },
  { id: "office", top: [0.04, 0.06, 0.13], bottom: [0.22, 0.22, 0.23], skin: [0.72, 0.52, 0.42], names: ["Leo", "Felix", "Owen", "Ben", "Hugo", "Isaac", "Martin"] },
  { id: "nurse", top: [0.05, 0.3, 0.32], bottom: [0.05, 0.3, 0.32], skin: [0.26, 0.15, 0.1], names: ["Amara", "Grace", "Ruth", "Yara", "Rosa", "Leila", "Nia"] },
  { id: "worker", top: [0.8, 0.28, 0.02], bottom: [0.12, 0.12, 0.11], skin: [0.42, 0.27, 0.18], names: ["Omar", "Malik", "Kofi", "Tariq", "Diego", "Mateo", "Sami"] },
  { id: "coat", top: [0.16, 0.17, 0.08], bottom: [0.03, 0.03, 0.035], skin: [0.78, 0.58, 0.48], names: ["Elena", "Sofia", "Lucia", "Ines", "Nina", "Mei", "Keiko"] },
  { id: "varsity", top: [0.42, 0.04, 0.05], bottom: [0.03, 0.03, 0.04], skin: [0.5, 0.33, 0.22], names: ["Kai", "Nico", "Theo", "Ezra", "Raj", "Arjun", "Jonah"] },
];

export function customerLook(seed: number): CustomerLook {
  return CUSTOMER_LOOKS[seed % CUSTOMER_LOOKS.length]!;
}

export function customerName(seed: number): string {
  const names = customerLook(seed).names;
  return names[Math.floor(seed / CUSTOMER_LOOKS.length) % names.length]!;
}
