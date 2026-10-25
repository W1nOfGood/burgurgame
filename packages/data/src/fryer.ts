/**
 * The fryer station: two oil vats on the cook line. A portion of fries set over a vat cooks in
 * about forty seconds and burns if it is left; a ticket with fries is served with a good
 * portion on the pickup shelf beside the tray.
 */

/** Switch for the whole fries feature (supply line, ticket side, serving). */
export const FRIES_ENABLED = true;

/** What a portion of fries adds to the sale. */
export const FRIES_PRICE_CENTS = 300;

export const FRYER = {
  /** Vat openings (m), matching the modelled fryer (kitchen.py, fryer()). */
  vats: [
    { minX: 1.14, maxX: 1.48, minZ: 4.32, maxZ: 4.78 },
    { minX: 1.52, maxX: 1.86, minZ: 4.32, maxZ: 4.78 },
  ] as const,
  /** Height of the deck the portion rests on over a vat. */
  deckY: 0.9,
  /** Oil temperature, °C (the fryer is always hot). */
  oilTemp: 175,
  /** Seconds to cook a raw portion through. */
  cookSeconds: 40,
  /** Seconds after it is cooked until it counts as burnt. */
  burnSeconds: 15,
  /** Cooked far enough to serve. */
  servedAt: 0.85,
  /** Burn level at which it is no longer fit to serve. */
  burntAbove: 0.25,
} as const;

/** Vat index a portion resting at this foot position sits over, or -1. */
export function fryerVatAt(x: number, y: number, z: number): number {
  if (Math.abs(y - FRYER.deckY) > 0.08) return -1;
  return FRYER.vats.findIndex((v) => x >= v.minX && x <= v.maxX && z >= v.minZ && z <= v.maxZ);
}
