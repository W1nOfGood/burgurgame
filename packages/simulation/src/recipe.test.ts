import { describe, expect, it } from "vitest";
import { RECIPES, RECIPE_IDS, SAUCE_BIT, modifiersFor, type ItemKind, type RecipeId } from "@ahb/data";
import { createFoodState, type FoodState } from "./food.js";
import { evaluateBurger, expectedLayers, expectedSauces, type ServedLayer } from "./recipe.js";

function layer(kind: ItemKind, patch: Partial<FoodState> = {}): ServedLayer {
  return { kind, food: { ...createFoodState(kind), ...patch } };
}

/** A well-made layer for any kind: cooked where needed, warm, toasted buns. */
function good(kind: ItemKind, grilled = false): ServedLayer {
  switch (kind) {
    case "patty":
    case "veggie_patty":
      return layer(kind, { cookA: 0.75, cookB: 0.72, inner: 0.95, temp: 70 });
    case "cheese":
    case "swiss":
      return layer(kind, { melt: 0.8, temp: 65 });
    case "bun_bottom":
    case "bun_top":
      return layer(kind, { toast: 0.55, temp: 40 });
    case "bacon":
    case "egg":
    case "mushroom":
      return layer(kind, { cookA: 0.75, temp: 60 });
    case "onion":
      return layer(kind, grilled ? { cookA: 0.6, temp: 55 } : {});
    default:
      return layer(kind);
  }
}

/** Builds a perfect burger for a recipe, sauced with exactly the right sauces. */
function perfect(id: RecipeId): ServedLayer[] {
  const def = RECIPES[id];
  const out = def.layers.map((k) => good(k, def.grilled?.includes(k) ?? false));
  const mask = def.sauces.reduce((m, s) => m | SAUCE_BIT[s], 0);
  const sauceLayer = out[out.length - 2]!;
  sauceLayer.food = { ...sauceLayer.food, sauce: def.sauces.length ? 0.45 : 0, sauceMask: mask };
  return out;
}

const classic = { recipe: "classic_cheeseburger" as const, modifiers: [] };

describe("recipe catalogue", () => {
  it("has many distinct, enabled recipes", () => {
    expect(RECIPE_IDS.length).toBeGreaterThanOrEqual(15);
    const builds = new Set(RECIPE_IDS.map((id) => `${RECIPES[id].layers.join(",")}|${RECIPES[id].sauces.join("+")}|${(RECIPES[id].grilled ?? []).join()}`));
    expect(builds.size).toBe(RECIPE_IDS.length);
    for (const id of RECIPE_IDS) {
      const l = RECIPES[id].layers;
      expect(l[0]).toBe("bun_bottom");
      expect(l[l.length - 1]).toBe("bun_top");
    }
  });

  it.each(RECIPE_IDS)("scores a perfect %s at 100", (id) => {
    const r = evaluateBurger(perfect(id), { recipe: id, modifiers: [] }, 20, 180);
    expect(r.feedback).toEqual(["Perfect burger!"]);
    expect(r.score).toBe(100);
    expect(r.priceCents).toBe(RECIPES[id].priceCents);
  });

  it("only offers modifiers that apply to the recipe", () => {
    expect(modifiersFor("triple_stack")).not.toContain("no_onion");
    expect(modifiersFor("hamburger")).toContain("no_onion");
    expect(modifiersFor("bacon_cheeseburger")).not.toContain("add_bacon");
    expect(modifiersFor("garden_veggie")).not.toContain("extra_cheese");
  });
});

describe("recipe evaluation", () => {
  it("reports specific missing ingredients", () => {
    const layers = perfect("classic_cheeseburger").filter((l) => l.kind !== "cheese");
    const r = evaluateBurger(layers, classic, 0, 180);
    expect(r.feedback).toContain("Missing cheese");
  });

  it("penalises stacking the right ingredients in the wrong order", () => {
    const layers = perfect("classic_cheeseburger");
    const [lettuce, tomato] = [layers[3]!, layers[4]!];
    layers[3] = tomato;
    layers[4] = lettuce;
    const r = evaluateBurger(layers, classic, 0, 180);
    expect(r.feedback).toEqual(["Stacked in the wrong order"]);
  });

  it("checks the exact sauces", () => {
    const wrong = perfect("hamburger");
    wrong[wrong.length - 2]!.food.sauceMask = SAUCE_BIT.ketchup | SAUCE_BIT.bbq;
    const r = evaluateBurger(wrong, { recipe: "hamburger", modifiers: [] }, 0, 180);
    expect(r.feedback).toContain("Missing mustard");
    expect(r.feedback).toContain("Didn't ask for BBQ sauce");
    expect(expectedSauces({ recipe: "hamburger", modifiers: [] })).toEqual(["ketchup", "mustard"]);
  });

  it("distinguishes grilled and raw onions", () => {
    const raw = perfect("smokehouse_bbq");
    raw[4] = layer("onion");
    expect(evaluateBurger(raw, { recipe: "smokehouse_bbq", modifiers: [] }, 0, 180).feedback).toContain("Onions should be grilled");
    const grilled = perfect("hamburger");
    grilled[2] = layer("onion", { cookA: 0.7 });
    expect(evaluateBurger(grilled, { recipe: "hamburger", modifiers: [] }, 0, 180).feedback).toContain("Onions should be raw");
  });

  it("requires grilled toppings to be cooked", () => {
    const b = perfect("bacon_cheeseburger");
    b[3] = layer("bacon", { cookA: 0.1 });
    expect(evaluateBurger(b, { recipe: "bacon_cheeseburger", modifiers: [] }, 0, 180).feedback).toContain("Bacon was undercooked");
    const e = perfect("sunrise_burger");
    e[4] = layer("egg", { cookA: 0.2 });
    expect(evaluateBurger(e, { recipe: "sunrise_burger", modifiers: [] }, 0, 180).feedback).toContain("Egg was runny");
  });

  it("checks veggie patties like beef", () => {
    const v = perfect("garden_veggie");
    v[1] = layer("veggie_patty", { cookA: 0.3, inner: 0.2, temp: 30 });
    expect(evaluateBurger(v, { recipe: "garden_veggie", modifiers: [] }, 0, 180).feedback).toContain("Veggie patty was undercooked in the middle");
  });

  it("penalises undercooked and burnt patties", () => {
    const raw = perfect("classic_cheeseburger");
    raw[1] = layer("patty", { cookA: 0.3, cookB: 0.0, inner: 0.2, temp: 30 });
    const r = evaluateBurger(raw, classic, 0, 180);
    expect(r.feedback).toContain("Patty was undercooked in the middle");
    expect(r.feedback).toContain("Burger had gone cold");
    const burnt = perfect("classic_cheeseburger");
    burnt[1] = layer("patty", { cookA: 1.5, cookB: 0.8, inner: 1.1, burn: 0.6, temp: 80 });
    expect(evaluateBurger(burnt, classic, 0, 180).feedback).toContain("Patty was burnt");
  });

  it("honours removal and addition modifiers", () => {
    const noPickle = { recipe: "classic_cheeseburger" as const, modifiers: ["no_pickle" as const] };
    expect(expectedLayers(noPickle)).not.toContain("pickle");
    expect(evaluateBurger(perfect("classic_cheeseburger"), noPickle, 0, 180).feedback).toContain("Asked for no pickles");
    const bacon = { recipe: "classic_cheeseburger" as const, modifiers: ["add_bacon" as const] };
    expect(expectedLayers(bacon)).toEqual(["bun_bottom", "patty", "cheese", "bacon", "lettuce", "tomato", "pickle", "bun_top"]);
  });

  it("refuses an unclosed, bunless pile", () => {
    const r = evaluateBurger([layer("patty"), layer("cheese")], classic, 0, 180);
    expect(r.accepted).toBe(false);
    expect(r.priceCents).toBe(0);
  });

  it("deducts for long waits", () => {
    expect(evaluateBurger(perfect("classic_cheeseburger"), classic, 280, 180).feedback).toContain("Order waited too long");
  });
});
