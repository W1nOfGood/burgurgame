import type { ItemKind } from "./items.js";
import { DRINKS_ENABLED } from "./drinks.js";

/** Fries ship with the fryer station. */
export const FRIES_ENABLED = false;

/** All money is integer cents. */
export const STARTING_BALANCE_CENTS = 20_000;

export type StockKey =
  | "patty"
  | "veggie_patty"
  | "bun_bottom"
  | "bun_top"
  | "cheese"
  | "swiss"
  | "lettuce"
  | "tomato"
  | "onion"
  | "pickle"
  | "bacon"
  | "mushroom"
  | "egg"
  | "jalapeno"
  | "sauce"
  | "cup"
  | "fries";

export const STOCK_KEYS: readonly StockKey[] = [
  "patty",
  "veggie_patty",
  "bun_bottom",
  "bun_top",
  "cheese",
  "swiss",
  "lettuce",
  "tomato",
  "onion",
  "pickle",
  "bacon",
  "mushroom",
  "egg",
  "jalapeno",
  "sauce",
  "cup",
  "fries",
];

/** Names for the supply catalog. */
export const STOCK_LABEL: Record<StockKey, string> = {
  patty: "Beef patties",
  veggie_patty: "Veggie patties",
  bun_bottom: "Bottom buns",
  bun_top: "Top buns",
  cheese: "Cheddar slices",
  swiss: "Swiss slices",
  lettuce: "Lettuce leaves",
  tomato: "Tomato slices",
  onion: "Onion rings",
  pickle: "Pickle chips",
  bacon: "Bacon strips",
  mushroom: "Mushrooms",
  egg: "Eggs",
  jalapeno: "Jalapeños",
  sauce: "Sauce refills",
  cup: "Paper cups",
  fries: "Frozen fries (portions)",
};

/** What the office computer sells: lines whose feature is switched off are left out. */
export const CATALOG_KEYS: readonly StockKey[] = STOCK_KEYS.filter((k) => (k !== "cup" || DRINKS_ENABLED) && (k !== "fries" || FRIES_ENABLED));

/** Packs a single order may buy. */
export const MAX_PACKS_PER_ORDER = 10;

export const STARTING_STOCK: Record<StockKey, number> = {
  patty: 40,
  veggie_patty: 20,
  bun_bottom: 40,
  bun_top: 40,
  cheese: 40,
  swiss: 30,
  lettuce: 60,
  tomato: 60,
  onion: 60,
  pickle: 80,
  bacon: 40,
  mushroom: 40,
  egg: 30,
  jalapeno: 60,
  sauce: 30,
  cup: 60,
  fries: 30,
};

/** Restock packs bought from the office catalog (Stage 4 UI). */
export const RESTOCK_PACKS: Record<StockKey, { quantity: number; priceCents: number }> = {
  patty: { quantity: 20, priceCents: 1600 },
  bun_bottom: { quantity: 24, priceCents: 420 },
  bun_top: { quantity: 24, priceCents: 420 },
  cheese: { quantity: 24, priceCents: 540 },
  lettuce: { quantity: 30, priceCents: 260 },
  tomato: { quantity: 30, priceCents: 320 },
  onion: { quantity: 30, priceCents: 200 },
  pickle: { quantity: 40, priceCents: 200 },
  veggie_patty: { quantity: 12, priceCents: 780 },
  swiss: { quantity: 24, priceCents: 660 },
  bacon: { quantity: 30, priceCents: 840 },
  mushroom: { quantity: 30, priceCents: 540 },
  egg: { quantity: 24, priceCents: 560 },
  jalapeno: { quantity: 40, priceCents: 300 },
  sauce: { quantity: 10, priceCents: 300 },
  cup: { quantity: 50, priceCents: 1200 },
  fries: { quantity: 24, priceCents: 900 },
};

export function stockKeyFor(kind: ItemKind): StockKey | null {
  return (STOCK_KEYS as readonly string[]).includes(kind) ? (kind as StockKey) : null;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
