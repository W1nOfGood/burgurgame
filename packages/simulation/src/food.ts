import { COOKING, type ItemKind } from "@ahb/data";
import { clamp, clamp01 } from "./vec.js";

/**
 * Authoritative food state, independent from rendering (spec §8). All values are fictional
 * game units; nothing here is real-world food-safety guidance.
 */
export interface FoodState {
  /** Browning of side A (0 raw, ~0.5–0.95 ideal, >1 burning). */
  cookA: number;
  /** Browning of side B. */
  cookB: number;
  /** Simplified internal cooking progress (0 raw … 1 cooked through). */
  inner: number;
  /** Char/burn level 0..1. */
  burn: number;
  /** Current warmth in fictional °C. */
  temp: number;
  /** Remaining moisture 1..0. */
  moisture: number;
  /** Cheese softening 0..1. */
  melt: number;
  /** Bun toasting 0..~1.5. */
  toast: number;
  /** Which side faces down: 0 = side A, 1 = side B. */
  down: 0 | 1;
  /** Sauce units applied on this layer. */
  sauce: number;
  /** Which sauces were applied (SAUCE_BIT flags). */
  sauceMask: number;
  /** Touched the floor or otherwise contaminated. */
  dirty: boolean;
  /** Seconds since the item left stock. */
  age: number;
}

export function createFoodState(kind: ItemKind): FoodState {
  return {
    cookA: 0,
    cookB: 0,
    inner: 0,
    burn: 0,
    temp: kind === "patty" || kind === "veggie_patty" || kind === "cheese" || kind === "swiss" || kind === "bacon" || kind === "egg" ? COOKING.fridgeTemp : COOKING.ambientTemp,
    moisture: 1,
    melt: 0,
    toast: 0,
    down: 0,
    sauce: 0,
    sauceMask: 0,
    dirty: false,
    age: 0,
  };
}

/** Heat environment for one simulation step. */
export interface HeatEnv {
  /** Temperature of a cooking surface the item is in direct contact with, or null. */
  contactTemp: number | null;
  /** Temperature of the food directly beneath (stacked), or null. */
  belowTemp: number | null;
}

/** Converts a surface temperature into a 0..~1.2 heat factor. */
export function heatFactor(surfaceTemp: number): number {
  return clamp((surfaceTemp - COOKING.browningOnset) / COOKING.browningSpan, 0, 1.3);
}

/** Grill zone surface temperature after one step toward its knob setting. */
export function stepGrillTemp(current: number, knob: number, dt: number): number {
  const target = COOKING.ambientTemp + clamp01(knob) * (COOKING.grillMaxTemp - COOKING.ambientTemp);
  const k = 1 - Math.exp(-COOKING.grillResponse * dt);
  return current + (target - current) * k;
}

function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Advances one food item by dt seconds. Mutates and returns the state. */
export function stepFood(kind: ItemKind, s: FoodState, env: HeatEnv, dt: number): FoodState {
  s.age += dt;
  const contact = env.contactTemp;

  if (kind === "patty" || kind === "veggie_patty") {
    if (contact !== null) {
      const f = heatFactor(contact) * (COOKING.rateFactor[kind] ?? 1);
      const side = COOKING.sideRate * f * dt;
      const upper = side * COOKING.upperSideFraction;
      if (s.down === 0) {
        s.cookA += side;
        s.cookB += upper;
      } else {
        s.cookB += side;
        s.cookA += upper;
      }
      // Drier patties cook through slightly faster but lose quality.
      s.inner += COOKING.innerRate * f * dt * (0.85 + 0.3 * (1 - s.moisture));
      s.moisture = clamp01(s.moisture - COOKING.moistureRate * f * dt * (1 + 2 * s.burn));
      const downCook = s.down === 0 ? s.cookA : s.cookB;
      if (downCook > 1) s.burn = clamp01(s.burn + (downCook - 1) * COOKING.burnRate * dt);
      const targetTemp = COOKING.ambientTemp + (contact - COOKING.ambientTemp) * COOKING.contactTempFraction;
      s.temp = approach(s.temp, targetTemp, COOKING.heatResponse, dt);
    } else {
      s.temp = approach(s.temp, env.belowTemp ?? COOKING.ambientTemp, COOKING.coolResponse, dt);
    }
    s.inner = Math.min(s.inner, 1.25);
    s.cookA = Math.min(s.cookA, 1.6);
    s.cookB = Math.min(s.cookB, 1.6);
    return s;
  }

  if (kind === "cheese" || kind === "swiss") {
    if (contact !== null) {
      // Cheese straight on the grill melts fast and scorches.
      const f = heatFactor(contact);
      s.melt = clamp01(s.melt + COOKING.meltRate * 3 * f * dt);
      if (s.melt >= 1) s.burn = clamp01(s.burn + 0.25 * f * dt);
      s.temp = approach(s.temp, contact * COOKING.contactTempFraction, COOKING.heatResponse, dt);
    } else {
      const below = env.belowTemp;
      if (below !== null && below > COOKING.meltOnset) {
        const rate = ((below - COOKING.meltOnset) / COOKING.meltSpan) * COOKING.meltRate;
        s.melt = clamp01(s.melt + rate * dt);
      }
      s.temp = approach(s.temp, below ?? COOKING.ambientTemp, below !== null ? COOKING.heatResponse : COOKING.coolResponse, dt);
    }
    return s;
  }

  if (kind === "bun_bottom" || kind === "bun_top") {
    if (contact !== null) {
      const f = heatFactor(contact);
      s.toast = Math.min(1.6, s.toast + COOKING.toastRate * f * dt);
      if (s.toast > 1) s.burn = clamp01(s.burn + (s.toast - 1) * COOKING.burnRate * dt);
      s.temp = approach(s.temp, COOKING.ambientTemp + (contact - COOKING.ambientTemp) * 0.2, COOKING.heatResponse, dt);
    } else {
      s.temp = approach(s.temp, env.belowTemp ?? COOKING.ambientTemp, COOKING.coolResponse, dt);
    }
    return s;
  }

  // Grill toppings (bacon, egg, mushrooms, onions) cook as one value; salad items wilt.
  if (contact !== null) {
    const f = heatFactor(contact) * (COOKING.rateFactor[kind] ?? 1);
    s.cookA = Math.min(1.6, s.cookA + COOKING.sideRate * f * dt);
    if (s.cookA > 1) s.burn = clamp01(s.burn + (s.cookA - 1) * COOKING.burnRate * dt);
    s.temp = approach(s.temp, contact * COOKING.contactTempFraction, COOKING.heatResponse, dt);
  } else {
    s.temp = approach(s.temp, env.belowTemp ?? COOKING.ambientTemp, COOKING.coolResponse, dt);
  }
  return s;
}

/** Sizzle loudness 0..1 for audio feedback; derived purely from authoritative values. */
export function sizzleLevel(kind: ItemKind, s: FoodState, contactTemp: number | null): number {
  if (contactTemp === null) return 0;
  const f = heatFactor(contactTemp);
  if (kind === "patty" || kind === "veggie_patty" || kind === "bacon") return clamp01(f * (0.35 + 0.65 * s.moisture) + s.burn * 0.3);
  return clamp01(f * 0.4);
}

/** Human-readable doneness used in inspection labels. */
export function pattyDoneness(s: FoodState): "raw" | "rare" | "medium" | "cooked" | "overdone" | "burnt" {
  if (s.burn > 0.5) return "burnt";
  if (s.inner < 0.35) return "raw";
  if (s.inner < 0.7) return "rare";
  if (s.inner < 0.85) return "medium";
  if (s.inner < 1.12) return "cooked";
  return "overdone";
}

/** Quantises a 0..max float to a byte for replication. */
export function toByte(value: number, max = 1): number {
  return Math.round(clamp01(value / max) * 255);
}

export function fromByte(value: number, max = 1): number {
  return (value / 255) * max;
}

/** Ranges used when quantising food fields to bytes. */
export const FOOD_BYTE_RANGE = {
  cook: 1.6,
  inner: 1.25,
  burn: 1,
  temp: 120,
  moisture: 1,
  melt: 1,
  toast: 1.6,
  sauce: 2,
} as const;
