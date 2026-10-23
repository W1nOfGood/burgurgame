import {
  COOKING,
  ITEMS,
  MODIFIERS,
  RECIPES,
  SAUCE_BIT,
  SAUCE_KINDS,
  SAUCE_LABEL,
  SCORING,
  isCheese,
  isPatty,
  type ItemKind,
  type ModifierId,
  type RecipeId,
  type SauceKind,
} from "@ahb/data";
import type { FoodState } from "./food.js";

export interface ServedLayer {
  kind: ItemKind;
  food: FoodState;
}

export interface OrderSpec {
  recipe: RecipeId;
  modifiers: readonly ModifierId[];
}

export interface Evaluation {
  score: number;
  /** Specific, player-facing feedback lines, most important first. */
  feedback: string[];
  priceCents: number;
  tipCents: number;
  accepted: boolean;
}

/** The ingredient list an order expects, bottom to top, after modifiers. */
export function expectedLayers(order: OrderSpec): ItemKind[] {
  const layers = [...RECIPES[order.recipe].layers];
  for (const id of order.modifiers) {
    const mod = MODIFIERS[id];
    if (mod.remove) {
      const i = layers.indexOf(mod.remove);
      if (i >= 0) layers.splice(i, 1);
    }
    if (mod.add) {
      const anchor = mod.after ? layers.indexOf(mod.after) : -1;
      layers.splice(anchor >= 0 ? anchor + 1 : layers.length - 1, 0, mod.add);
    }
  }
  return layers;
}

export function expectedSauces(order: OrderSpec): SauceKind[] {
  return [...RECIPES[order.recipe].sauces];
}

export function expectedSauceAmount(order: OrderSpec): number {
  if (RECIPES[order.recipe].sauces.length === 0) return 0;
  let amount: number = SCORING.sauceMin;
  for (const id of order.modifiers) amount += MODIFIERS[id].extraSauce ?? 0;
  return amount;
}

export function orderPrice(order: OrderSpec): number {
  let price = RECIPES[order.recipe].priceCents;
  for (const id of order.modifiers) price += MODIFIERS[id].priceDeltaCents;
  return price;
}

function countKinds(kinds: readonly ItemKind[]): Map<ItemKind, number> {
  const m = new Map<ItemKind, number>();
  for (const k of kinds) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

const LABEL: Partial<Record<ItemKind, string>> = {
  patty: "patty",
  veggie_patty: "veggie patty",
  bun_bottom: "bottom bun",
  bun_top: "top bun",
  cheese: "cheese",
  swiss: "Swiss",
  lettuce: "lettuce",
  tomato: "tomato",
  onion: "onions",
  pickle: "pickles",
  bacon: "bacon",
  mushroom: "mushrooms",
  egg: "egg",
  jalapeno: "jalapeños",
};

function label(kind: ItemKind): string {
  return LABEL[kind] ?? ITEMS[kind].label.toLowerCase();
}

/** A layer's single cook value for grilled toppings. */
function toppingCook(f: FoodState): number {
  return Math.max(f.cookA, f.cookB);
}

/**
 * Scores a served burger against an order. Pure and deterministic so the server, tests, and a
 * future practice mode all agree (spec §9).
 */
export function evaluateBurger(layers: readonly ServedLayer[], order: OrderSpec, waitSeconds: number, patienceSeconds: number): Evaluation {
  const feedback: { weight: number; text: string }[] = [];
  let score = 100;
  const deduct = (points: number, text: string) => {
    score -= points;
    feedback.push({ weight: points, text });
  };
  const recipe = RECIPES[order.recipe];
  const expected = expectedLayers(order);
  const served = layers.map((l) => l.kind);

  if (served.length === 0) {
    return { score: 0, feedback: ["The tray was empty"], priceCents: 0, tipCents: 0, accepted: false };
  }

  // Structure: bottom bun first, top bun last.
  if (served[0] !== "bun_bottom") deduct(SCORING.missingBun, "Burger needs a bottom bun underneath");
  if (served[served.length - 1] !== "bun_top") {
    deduct(SCORING.burgerNotClosed, served.includes("bun_top") ? "Top bun isn't on top" : "Burger wasn't closed with a top bun");
  }

  // Ingredients present vs requested.
  const want = countKinds(expected);
  const have = countKinds(served);
  let countsMatch = true;
  for (const [kind, n] of want) {
    if (kind === "bun_bottom" || kind === "bun_top") continue;
    const missing = n - (have.get(kind) ?? 0);
    if (missing !== 0) countsMatch = false;
    for (let i = 0; i < missing; i++) deduct(SCORING.missingIngredient, `Missing ${label(kind)}`);
  }
  for (const [kind, n] of have) {
    if (kind === "bun_bottom" || kind === "bun_top") continue;
    const extra = n - (want.get(kind) ?? 0);
    if (extra !== 0) countsMatch = false;
    for (let i = 0; i < extra; i++) {
      const removed = order.modifiers.some((m) => MODIFIERS[m].remove === kind);
      deduct(SCORING.unwantedIngredient, removed ? `Asked for no ${label(kind)}` : `${capital(label(kind))} doesn't go on a ${recipe.label}`);
    }
  }
  // Right ingredients, wrong stacking order: the build has to be learned, not just the list.
  if (countsMatch) {
    const fill = (k: readonly ItemKind[]) => k.filter((x) => x !== "bun_bottom" && x !== "bun_top").join(",");
    if (fill(served) !== fill(expected)) deduct(SCORING.wrongOrder, "Stacked in the wrong order");
  }

  // Cooking quality.
  const grilledRequired = new Set(recipe.grilled ?? []);
  let coldest = Number.POSITIVE_INFINITY;
  layers.forEach((layer, i) => {
    const s = layer.food;
    const k = layer.kind;
    if (s.dirty) deduct(SCORING.dirtyFood, `${capital(label(k))} had been dropped on the floor`);
    if (isPatty(k)) {
      coldest = Math.min(coldest, s.temp);
      const name = k === "veggie_patty" ? "Veggie patty" : "Patty";
      if (s.inner < SCORING.undercookedBelow) deduct(SCORING.undercookedPatty, `${name} was undercooked in the middle`);
      else if (s.inner < SCORING.cookedThrough) deduct(Math.round(SCORING.undercookedPatty / 3), `${name} needed a little longer`);
      if (s.burn > SCORING.burntAbove) deduct(SCORING.burntPatty, `${name} was burnt`);
      const pale = Math.min(s.cookA, s.cookB) < SCORING.idealBrowningMin;
      if (pale && s.burn <= SCORING.burntAbove) deduct(SCORING.paleSurface, `One side of the ${name.toLowerCase()} was pale — flip it`);
    }
    if (isCheese(k)) {
      const below = layers[i - 1];
      // Cheese only melts on hot food; a slice tucked under cold veg can stay firm.
      if (s.melt < SCORING.meltedAbove && below && isPatty(below.kind)) deduct(SCORING.cheeseNotMelted, `${k === "swiss" ? "Swiss" : "Cheese"} wasn't melted`);
    }
    if (k === "bun_bottom" || k === "bun_top") {
      if (s.toast > SCORING.bunBurntAbove || s.burn > SCORING.burntAbove) deduct(SCORING.bunBurnt, "Bun was burnt");
      else if (s.toast < SCORING.toastedAbove) deduct(SCORING.bunNotToasted, "Bun wasn't toasted");
    }
    if (k === "bacon" || k === "mushroom" || k === "egg") {
      const c = toppingCook(s);
      const text = k === "bacon" ? "Bacon was undercooked" : k === "mushroom" ? "Mushrooms were raw" : "Egg was runny";
      if (c < SCORING.toppingCooked) deduct(SCORING.undercookedTopping, text);
      else if (s.burn > SCORING.burntAbove) deduct(SCORING.burntTopping, `${capital(label(k))} ${k === "mushroom" ? "were" : "was"} burnt`);
    }
    if (k === "onion" && want.has("onion")) {
      const grilled = toppingCook(s) > SCORING.onionGrilledAbove;
      if (grilledRequired.has("onion") && !grilled) deduct(SCORING.onionWrongStyle, "Onions should be grilled");
      if (!grilledRequired.has("onion") && grilled) deduct(SCORING.onionWrongStyle, "Onions should be raw");
    }
    if ((k === "lettuce" || k === "tomato" || k === "pickle" || k === "jalapeno") && toppingCook(s) > 0.3) deduct(SCORING.wilted, `${capital(label(k))} got cooked`);
  });
  if (Number.isFinite(coldest) && coldest < COOKING.warmServeTemp) deduct(SCORING.coldFood, "Burger had gone cold");

  // Sauces: the right ones, and enough of them.
  const amount = layers.reduce((sum, l) => sum + l.food.sauce, 0);
  const mask = layers.reduce((m, l) => m | l.food.sauceMask, 0);
  const wantSauces = expectedSauces(order);
  for (const sauce of wantSauces) if ((mask & SAUCE_BIT[sauce]) === 0) deduct(SCORING.missingSauce, `Missing ${SAUCE_LABEL[sauce]}`);
  for (const sauce of SAUCE_KINDS) {
    if ((mask & SAUCE_BIT[sauce]) !== 0 && !wantSauces.includes(sauce)) deduct(SCORING.wrongSauce, `Didn't ask for ${SAUCE_LABEL[sauce]}`);
  }
  const wantAmount = expectedSauceAmount(order);
  if (wantAmount > 0 && amount > 0 && amount < wantAmount * 0.6) {
    deduct(SCORING.notEnoughSauce, order.modifiers.includes("extra_sauce") ? "Asked for extra sauce" : "Not enough sauce");
  }
  if (amount > SCORING.tooMuchSauceAbove + (wantAmount - SCORING.sauceMin)) deduct(SCORING.tooMuchSauce, "Way too much sauce");

  // Waiting time.
  const over = Math.max(0, waitSeconds - patienceSeconds);
  if (over > 0) {
    const points = Math.min(SCORING.maxWaitDeduction, Math.floor(over / 10) * SCORING.waitPer10s);
    if (points > 0) deduct(points, "Order waited too long");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const accepted = score >= SCORING.refuseBelow;
  const price = accepted ? orderPrice(order) : 0;
  const tipFraction = score > SCORING.tipFromScore ? ((score - SCORING.tipFromScore) / (100 - SCORING.tipFromScore)) * SCORING.maxTipFraction : 0;
  const tip = accepted ? Math.round(price * tipFraction) : 0;
  feedback.sort((a, b) => b.weight - a.weight);
  const lines = [...new Set(feedback.map((f) => f.text))];
  if (lines.length === 0) lines.push("Perfect burger!");
  return { score, feedback: lines, priceCents: price, tipCents: tip, accepted };
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
