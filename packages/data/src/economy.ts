import type { ItemKind } from "./items.js";

/** All money is integer cents. */
export const STARTING_BALANCE_CENTS = 20_000;

export type StockKey = Exclude<ItemKind, "tray" | "spatula" | "sauce_bottle"> | "sauce";

export const STOCK_KEYS: readonly StockKey[] = [
  "patty",
  "bun_bottom",
  "bun_top",
  "cheese",
  "lettuce",
  "tomato",
  "onion",
  "pickle",
  "sauce",
];

export const STARTING_STOCK: Record<StockKey, number> = {
  patty: 40,
  bun_bottom: 40,
  bun_top: 40,
  cheese: 40,
  lettuce: 60,
  tomato: 60,
  onion: 60,
  pickle: 80,
  sauce: 30,
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
  sauce: { quantity: 10, priceCents: 300 },
};

export function stockKeyFor(kind: ItemKind): StockKey | null {
  if (kind === "tray" || kind === "spatula" || kind === "sauce_bottle") return null;
  return kind;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
