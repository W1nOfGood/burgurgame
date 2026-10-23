/**
 * Fountain drinks. The soda fountain behind the drinks cabinet (east of the pass) has six
 * valves; a cup set on the drip tray under a valve fills with that drink. Tickets may ask for one
 * drink, served as a full cup on the pickup shelf beside the burger's tray.
 */
export type DrinkId = "iced_tea" | "orange" | "root_beer" | "lemon_lime" | "zero" | "cola";

export interface DrinkDef {
  id: DrinkId;
  label: string;
  /** Liquid colour (sRGB 0..1) for the client's cup view. */
  color: readonly [number, number, number];
  priceCents: number;
}

/**
 * In valve order along +x (code = index + 1 in ItemState.drink). Seen from the kitchen the
 * panel reads Fizz Cola … Iced Tea left to right, and the kitchen side looks toward -z, so the
 * leftmost label sits at the largest x.
 */
export const DRINKS: readonly DrinkDef[] = [
  { id: "iced_tea", label: "Iced Tea", color: [0.55, 0.3, 0.08], priceCents: 200 },
  { id: "orange", label: "Orange Burst", color: [0.98, 0.5, 0.06], priceCents: 200 },
  { id: "root_beer", label: "Root Beer", color: [0.2, 0.08, 0.04], priceCents: 200 },
  { id: "lemon_lime", label: "Lemon Lime", color: [0.86, 0.95, 0.62], priceCents: 200 },
  { id: "zero", label: "Zero Fizz", color: [0.16, 0.07, 0.04], priceCents: 200 },
  { id: "cola", label: "Fizz Cola", color: [0.17, 0.07, 0.035], priceCents: 200 },
];

export const DRINK_IDS: readonly DrinkId[] = DRINKS.map((d) => d.id);

export function drinkById(id: string): DrinkDef | undefined {
  return DRINKS.find((d) => d.id === id);
}

/** ItemState.drink code (0 = empty cup). */
export function drinkCode(id: DrinkId): number {
  return DRINK_IDS.indexOf(id) + 1;
}

export function drinkOfCode(code: number): DrinkDef | undefined {
  return code > 0 ? DRINKS[code - 1] : undefined;
}

export const SODA_FOUNTAIN = {
  /** Valve (nozzle) x positions, matching the modelled fountain (kitchen.py, drinks()). */
  valveX: [4.46, 4.676, 4.892, 5.108, 5.324, 5.54] as readonly number[],
  /** A cup this close to a valve's x (and on the drip tray) is under it. */
  valveHalfWidth: 0.08,
  /** Drip tray: the strip in front of the tower, at the grate's height. */
  trayMinZ: 1.12,
  trayMaxZ: 1.3,
  trayY: 1.03,
  /** Nozzle tip height (pour stream). */
  nozzleY: 1.21,
  nozzleZ: 1.19,
  /** Seconds to fill an empty cup. */
  fillSeconds: 3,
  /** Fill fraction at which a cup counts as a served drink. */
  fullAt: 0.85,
} as const;

/** Valve index a cup at this resting position sits under, or -1. */
export function valveAt(x: number, y: number, z: number): number {
  const f = SODA_FOUNTAIN;
  if (Math.abs(y - f.trayY) > 0.06 || z < f.trayMinZ || z > f.trayMaxZ) return -1;
  let best = -1;
  let bestD: number = f.valveHalfWidth;
  f.valveX.forEach((vx, i) => {
    const d = Math.abs(x - vx);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/**
 * Drinks are switched off until the client shows cups, pours and drink tickets: with this false
 * no ticket asks for a drink and the cup stacks hand out nothing.
 */
export const DRINKS_ENABLED = false;

/** Chance a walk-in customer also orders a drink. */
export const DRINK_CHANCE = DRINKS_ENABLED ? 0.5 : 0;
