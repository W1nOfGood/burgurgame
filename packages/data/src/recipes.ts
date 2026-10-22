import type { ItemKind } from "./items.js";

export type RecipeId = "classic_cheeseburger" | "double_cheeseburger" | "mushroom_burger";

export interface RecipeDef {
  id: RecipeId;
  label: string;
  /** Layers from bottom to top. Order between fillings is not scored; buns and cheese-on-patty are. */
  layers: readonly ItemKind[];
  /** Minimum sauce units on the burger, 0 when no sauce is required. */
  sauce: number;
  priceCents: number;
  /** Disabled recipes are defined for later stages and never ordered yet. */
  enabled: boolean;
}

export const RECIPES: Record<RecipeId, RecipeDef> = {
  classic_cheeseburger: {
    id: "classic_cheeseburger",
    label: "Classic Cheeseburger",
    layers: ["bun_bottom", "patty", "cheese", "lettuce", "tomato", "pickle", "bun_top"],
    sauce: 0.3,
    priceCents: 750,
    enabled: true,
  },
  double_cheeseburger: {
    id: "double_cheeseburger",
    label: "Double Cheeseburger",
    layers: ["bun_bottom", "patty", "cheese", "patty", "cheese", "onion", "pickle", "bun_top"],
    sauce: 0.3,
    priceCents: 1050,
    enabled: false,
  },
  mushroom_burger: {
    id: "mushroom_burger",
    label: "Grilled Mushroom Burger",
    layers: ["bun_bottom", "patty", "cheese", "onion", "bun_top"],
    sauce: 0.2,
    priceCents: 950,
    enabled: false,
  },
};

export type ModifierId = "no_onion" | "no_pickle" | "no_tomato" | "extra_cheese" | "extra_sauce";

export interface ModifierDef {
  id: ModifierId;
  label: string;
  remove?: ItemKind;
  add?: ItemKind;
  extraSauce?: number;
  priceDeltaCents: number;
  enabled: boolean;
}

export const MODIFIERS: Record<ModifierId, ModifierDef> = {
  no_onion: { id: "no_onion", label: "No onions", remove: "onion", priceDeltaCents: 0, enabled: true },
  no_pickle: { id: "no_pickle", label: "No pickles", remove: "pickle", priceDeltaCents: 0, enabled: true },
  no_tomato: { id: "no_tomato", label: "No tomato", remove: "tomato", priceDeltaCents: 0, enabled: true },
  extra_cheese: { id: "extra_cheese", label: "Extra cheese", add: "cheese", priceDeltaCents: 75, enabled: true },
  extra_sauce: { id: "extra_sauce", label: "Extra sauce", extraSauce: 0.3, priceDeltaCents: 0, enabled: true },
};

/**
 * Scoring weights (spec §9: explicit in data, tuned through playtests). Scores start at 100 and
 * deductions are applied; the result is clamped to 0..100.
 */
export const SCORING = {
  missingIngredient: 22,
  unwantedIngredient: 14,
  missingBun: 40,
  burgerNotClosed: 25,
  undercookedPatty: 35,
  /** Internal progress at or above this counts as cooked through. */
  cookedThrough: 0.85,
  /** Internal progress below this counts as raw in the middle. */
  undercookedBelow: 0.7,
  /** Surface browning window regarded as ideal. */
  idealBrowningMin: 0.5,
  idealBrowningMax: 0.95,
  paleSurface: 10,
  burntPatty: 28,
  /** Burn level that counts as burnt. */
  burntAbove: 0.25,
  cheeseNotMelted: 8,
  meltedAbove: 0.45,
  cheeseNotOnPatty: 6,
  bunNotToasted: 5,
  toastedAbove: 0.35,
  bunBurnt: 12,
  bunBurntAbove: 1.15,
  coldFood: 12,
  missingSauce: 8,
  tooMuchSauce: 6,
  tooMuchSauceAbove: 1.6,
  dirtyFood: 60,
  /** Points deducted per 10 seconds an order waits beyond patience. */
  waitPer10s: 2,
  maxWaitDeduction: 30,
  /** Orders scoring below this are refused (no payment) in normal shifts. */
  refuseBelow: 25,
  /** Tip as a fraction of price for a perfect score; scales linearly from score 70. */
  maxTipFraction: 0.2,
  tipFromScore: 70,
} as const;
