import type { ItemKind, SauceKind } from "./items.js";

export type RecipeId =
  | "starter"
  | "classic_cheeseburger"
  | "hamburger"
  | "double_cheeseburger"
  | "bacon_cheeseburger"
  | "smokehouse_bbq"
  | "mushroom_swiss"
  | "sunrise_burger"
  | "inferno"
  | "garden_veggie"
  | "swiss_melt"
  | "california"
  | "triple_stack"
  | "sunrise_veggie"
  | "smash_double"
  | "after_hours_special"
  | "forager";

export interface RecipeDef {
  id: RecipeId;
  label: string;
  /** Layers from bottom to top. Fillings must be stacked in this order. */
  layers: readonly ItemKind[];
  /** Sauces the burger must carry (any layer), and no others. */
  sauces: readonly SauceKind[];
  /** Ingredients that must come off the grill rather than raw (e.g. grilled onions). */
  grilled?: readonly ItemKind[];
  priceCents: number;
  /** Unlock tier within a shift: 1 from the start, 2 and 3 as the night gets busier. */
  tier: 1 | 2 | 3;
  /** Short flavour line for the menu board and recipe book. */
  blurb: string;
  enabled: boolean;
  /** Only ordered by the tutorial's first customer, never at random. */
  tutorialOnly?: boolean;
}

const r = (def: Omit<RecipeDef, "enabled">): RecipeDef => ({ ...def, enabled: true });

/**
 * The menu. Tickets show only the name; cooks are expected to learn the builds (the recipe book
 * in the office and menu is there for lookups and learning).
 */
export const RECIPES: Record<RecipeId, RecipeDef> = {
  starter: r({
    id: "starter",
    label: "Starter Burger",
    layers: ["bun_bottom", "patty", "bun_top"],
    sauces: [],
    priceCents: 500,
    tier: 1,
    blurb: "Bun, patty, bun. Everyone's first.",
    tutorialOnly: true,
  }),
  classic_cheeseburger: r({
    id: "classic_cheeseburger",
    label: "Classic Cheeseburger",
    layers: ["bun_bottom", "patty", "cheese", "lettuce", "tomato", "pickle", "bun_top"],
    sauces: ["house"],
    priceCents: 750,
    tier: 1,
    blurb: "The one that started it all.",
  }),
  hamburger: r({
    id: "hamburger",
    label: "Plain Jane",
    layers: ["bun_bottom", "patty", "onion", "pickle", "bun_top"],
    sauces: ["ketchup", "mustard"],
    priceCents: 650,
    tier: 1,
    blurb: "Patty, raw onion, pickles, ketchup and mustard. No cheese.",
  }),
  double_cheeseburger: r({
    id: "double_cheeseburger",
    label: "Double Cheeseburger",
    layers: ["bun_bottom", "patty", "cheese", "patty", "cheese", "onion", "pickle", "bun_top"],
    sauces: ["ketchup", "mustard"],
    priceCents: 1050,
    tier: 1,
    blurb: "Two patties, two slices.",
  }),
  bacon_cheeseburger: r({
    id: "bacon_cheeseburger",
    label: "Bacon Cheeseburger",
    layers: ["bun_bottom", "patty", "cheese", "bacon", "lettuce", "tomato", "bun_top"],
    sauces: ["mayo"],
    priceCents: 950,
    tier: 2,
    blurb: "Crispy bacon over melted cheddar.",
  }),
  smokehouse_bbq: r({
    id: "smokehouse_bbq",
    label: "Smokehouse BBQ",
    layers: ["bun_bottom", "patty", "cheese", "bacon", "onion", "bun_top"],
    sauces: ["bbq"],
    grilled: ["onion"],
    priceCents: 1000,
    tier: 2,
    blurb: "Grilled onions, bacon and BBQ sauce.",
  }),
  mushroom_swiss: r({
    id: "mushroom_swiss",
    label: "Mushroom Swiss",
    layers: ["bun_bottom", "patty", "swiss", "mushroom", "bun_top"],
    sauces: ["mayo"],
    priceCents: 950,
    tier: 2,
    blurb: "Grilled mushrooms on Swiss.",
  }),
  sunrise_burger: r({
    id: "sunrise_burger",
    label: "Sunrise Burger",
    layers: ["bun_bottom", "patty", "cheese", "bacon", "egg", "bun_top"],
    sauces: ["ketchup"],
    priceCents: 1050,
    tier: 2,
    blurb: "Breakfast for the night shift: bacon and a fried egg.",
  }),
  garden_veggie: r({
    id: "garden_veggie",
    label: "Garden Veggie",
    layers: ["bun_bottom", "veggie_patty", "lettuce", "tomato", "onion", "pickle", "bun_top"],
    sauces: ["mayo"],
    priceCents: 850,
    tier: 2,
    blurb: "Veggie patty with the full garden.",
  }),
  inferno: r({
    id: "inferno",
    label: "Inferno",
    layers: ["bun_bottom", "patty", "cheese", "jalapeno", "onion", "bun_top"],
    sauces: ["house", "bbq"],
    priceCents: 950,
    tier: 3,
    blurb: "Jalapeños and raw onion, house and BBQ sauce.",
  }),
  swiss_melt: r({
    id: "swiss_melt",
    label: "Swiss Melt",
    layers: ["bun_bottom", "patty", "swiss", "onion", "bun_top"],
    sauces: ["mustard"],
    grilled: ["onion"],
    priceCents: 900,
    tier: 3,
    blurb: "Swiss and grilled onions with mustard.",
  }),
  california: r({
    id: "california",
    label: "California",
    layers: ["bun_bottom", "patty", "swiss", "lettuce", "tomato", "onion", "bun_top"],
    sauces: ["mayo", "house"],
    priceCents: 950,
    tier: 3,
    blurb: "Swiss, crisp greens, mayo and house sauce.",
  }),
  triple_stack: r({
    id: "triple_stack",
    label: "Triple Stack",
    layers: ["bun_bottom", "patty", "cheese", "patty", "cheese", "patty", "cheese", "bun_top"],
    sauces: ["house"],
    priceCents: 1350,
    tier: 3,
    blurb: "Three patties, three slices, nothing else.",
  }),
  sunrise_veggie: r({
    id: "sunrise_veggie",
    label: "Sunrise Veggie",
    layers: ["bun_bottom", "veggie_patty", "swiss", "egg", "tomato", "bun_top"],
    sauces: ["mayo"],
    priceCents: 950,
    tier: 3,
    blurb: "Veggie patty, Swiss, fried egg and tomato.",
  }),
  smash_double: r({
    id: "smash_double",
    label: "Smash Double",
    layers: ["bun_bottom", "patty", "patty", "onion", "pickle", "bun_top"],
    sauces: ["mustard"],
    grilled: ["onion"],
    priceCents: 950,
    tier: 3,
    blurb: "Two patties, grilled onions, pickles, mustard. No cheese.",
  }),
  after_hours_special: r({
    id: "after_hours_special",
    label: "After Hours Special",
    layers: ["bun_bottom", "patty", "cheese", "bacon", "egg", "jalapeno", "bun_top"],
    sauces: ["bbq", "mayo"],
    priceCents: 1250,
    tier: 3,
    blurb: "Everything the night cook wants at 3 a.m.",
  }),
  forager: r({
    id: "forager",
    label: "Forager",
    layers: ["bun_bottom", "veggie_patty", "swiss", "mushroom", "onion", "bun_top"],
    sauces: ["house"],
    grilled: ["onion"],
    priceCents: 1000,
    tier: 3,
    blurb: "Veggie patty, Swiss, mushrooms and grilled onions.",
  }),
};

export const RECIPE_IDS = Object.keys(RECIPES) as RecipeId[];

export type ModifierId = "no_onion" | "no_pickle" | "no_tomato" | "no_lettuce" | "extra_cheese" | "add_bacon" | "extra_sauce";

export interface ModifierDef {
  id: ModifierId;
  label: string;
  remove?: ItemKind;
  /** Added directly above the first layer of `after` (or before the top bun). */
  add?: ItemKind;
  after?: ItemKind;
  extraSauce?: number;
  priceDeltaCents: number;
  enabled: boolean;
}

export const MODIFIERS: Record<ModifierId, ModifierDef> = {
  no_onion: { id: "no_onion", label: "No onions", remove: "onion", priceDeltaCents: 0, enabled: true },
  no_pickle: { id: "no_pickle", label: "No pickles", remove: "pickle", priceDeltaCents: 0, enabled: true },
  no_tomato: { id: "no_tomato", label: "No tomato", remove: "tomato", priceDeltaCents: 0, enabled: true },
  no_lettuce: { id: "no_lettuce", label: "No lettuce", remove: "lettuce", priceDeltaCents: 0, enabled: true },
  extra_cheese: { id: "extra_cheese", label: "Extra cheese", add: "cheese", after: "cheese", priceDeltaCents: 75, enabled: true },
  add_bacon: { id: "add_bacon", label: "Add bacon", add: "bacon", after: "cheese", priceDeltaCents: 150, enabled: true },
  extra_sauce: { id: "extra_sauce", label: "Extra sauce", extraSauce: 0.3, priceDeltaCents: 0, enabled: true },
};

/** Which modifiers make sense for a recipe (you can't hold the onions on a burger without any). */
export function modifiersFor(recipe: RecipeId): ModifierId[] {
  const layers = RECIPES[recipe].layers;
  return (Object.keys(MODIFIERS) as ModifierId[]).filter((id) => {
    const m = MODIFIERS[id];
    if (!m.enabled) return false;
    if (m.remove) return layers.includes(m.remove);
    if (m.add === "bacon") return !layers.includes("bacon") && layers.includes("cheese");
    if (m.after) return layers.includes(m.after);
    if (m.extraSauce) return RECIPES[recipe].sauces.length > 0;
    return true;
  });
}

/**
 * Scoring weights (spec §9: explicit in data, tuned through playtests). Scores start at 100 and
 * deductions are applied; the result is clamped to 0..100.
 */
export const SCORING = {
  missingIngredient: 22,
  unwantedIngredient: 14,
  missingBun: 40,
  burgerNotClosed: 25,
  wrongOrder: 8,
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
  bunNotToasted: 5,
  toastedAbove: 0.35,
  bunBurnt: 12,
  bunBurntAbove: 1.15,
  /** Grilled toppings (bacon, mushrooms, egg): minimum cook to count as done. */
  toppingCooked: 0.45,
  undercookedTopping: 14,
  burntTopping: 12,
  /** Onions: grilled when cooked past this. */
  onionGrilledAbove: 0.35,
  onionWrongStyle: 8,
  wilted: 6,
  coldFood: 12,
  /** Minimum total sauce units when a recipe asks for sauce. */
  sauceMin: 0.3,
  missingSauce: 10,
  wrongSauce: 7,
  notEnoughSauce: 6,
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
