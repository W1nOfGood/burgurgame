import {
  COOKING,
  MODIFIERS,
  RECIPES,
  SCORING,
  type ItemKind,
  type ModifierId,
  type RecipeId,
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
      const i = layers.indexOf(mod.add);
      layers.splice(i >= 0 ? i + 1 : layers.length - 1, 0, mod.add);
    }
  }
  return layers;
}

export function expectedSauce(order: OrderSpec): number {
  let sauce = RECIPES[order.recipe].sauce;
  for (const id of order.modifiers) sauce += MODIFIERS[id].extraSauce ?? 0;
  return sauce;
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
  bun_bottom: "bottom bun",
  bun_top: "top bun",
  cheese: "cheese",
  lettuce: "lettuce",
  tomato: "tomato",
  onion: "onions",
  pickle: "pickles",
};

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
  for (const [kind, n] of want) {
    if (kind === "bun_bottom" || kind === "bun_top") continue;
    const missing = n - (have.get(kind) ?? 0);
    for (let i = 0; i < missing; i++) deduct(SCORING.missingIngredient, `Missing ${LABEL[kind] ?? kind}`);
  }
  for (const [kind, n] of have) {
    if (kind === "bun_bottom" || kind === "bun_top") continue;
    const extra = n - (want.get(kind) ?? 0);
    for (let i = 0; i < extra; i++) {
      const removed = order.modifiers.some((m) => MODIFIERS[m].remove === kind);
      deduct(SCORING.unwantedIngredient, removed ? `Asked for no ${LABEL[kind] ?? kind}` : `Extra ${LABEL[kind] ?? kind} wasn't ordered`);
    }
  }

  // Cooking quality.
  let coldest = Number.POSITIVE_INFINITY;
  layers.forEach((layer, i) => {
    const s = layer.food;
    if (s.dirty) deduct(SCORING.dirtyFood, `${capital(LABEL[layer.kind] ?? layer.kind)} had been dropped on the floor`);
    if (layer.kind === "patty") {
      coldest = Math.min(coldest, s.temp);
      if (s.inner < SCORING.undercookedBelow) deduct(SCORING.undercookedPatty, "Patty was undercooked in the middle");
      else if (s.inner < SCORING.cookedThrough) deduct(Math.round(SCORING.undercookedPatty / 3), "Patty needed a little longer");
      if (s.burn > SCORING.burntAbove) deduct(SCORING.burntPatty, "Patty was burnt");
      const pale = Math.min(s.cookA, s.cookB) < SCORING.idealBrowningMin;
      if (pale && s.burn <= SCORING.burntAbove) deduct(SCORING.paleSurface, "One side of the patty was pale — flip it");
    }
    if (layer.kind === "cheese") {
      if (s.melt < SCORING.meltedAbove) deduct(SCORING.cheeseNotMelted, "Cheese wasn't melted");
      if (layers[i - 1]?.kind !== "patty") deduct(SCORING.cheeseNotOnPatty, "Cheese should sit on the patty");
    }
    if (layer.kind === "bun_bottom" || layer.kind === "bun_top") {
      if (s.toast > SCORING.bunBurntAbove || s.burn > SCORING.burntAbove) deduct(SCORING.bunBurnt, "Bun was burnt");
      else if (s.toast < SCORING.toastedAbove) deduct(SCORING.bunNotToasted, "Bun wasn't toasted");
    }
  });
  if (Number.isFinite(coldest) && coldest < COOKING.warmServeTemp) deduct(SCORING.coldFood, "Burger had gone cold");

  // Sauce.
  const sauce = layers.reduce((sum, l) => sum + l.food.sauce, 0);
  const wantSauce = expectedSauce(order);
  if (wantSauce > 0 && sauce < wantSauce * 0.6) deduct(SCORING.missingSauce, wantSauce > RECIPES[order.recipe].sauce ? "Asked for extra sauce" : "Not enough sauce");
  if (sauce > SCORING.tooMuchSauceAbove + (wantSauce - RECIPES[order.recipe].sauce)) deduct(SCORING.tooMuchSauce, "Way too much sauce");

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
  const lines = feedback.map((f) => f.text);
  if (lines.length === 0) lines.push("Perfect burger!");
  return { score, feedback: dedupe(lines), priceCents: price, tipCents: tip, accepted };
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)];
}
