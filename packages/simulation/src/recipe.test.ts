import { describe, expect, it } from "vitest";
import type { ItemKind } from "@ahb/data";
import { createFoodState, type FoodState } from "./food.js";
import { evaluateBurger, expectedLayers, type ServedLayer } from "./recipe.js";

function layer(kind: ItemKind, patch: Partial<FoodState> = {}): ServedLayer {
  return { kind, food: { ...createFoodState(kind), ...patch } };
}

function perfectClassic(): ServedLayer[] {
  return [
    layer("bun_bottom", { toast: 0.6, temp: 40 }),
    layer("patty", { cookA: 0.75, cookB: 0.72, inner: 0.95, temp: 70 }),
    layer("cheese", { melt: 0.8, temp: 65 }),
    layer("lettuce"),
    layer("tomato"),
    layer("pickle", { sauce: 0.4 }),
    layer("bun_top", { toast: 0.5 }),
  ];
}

const classic = { recipe: "classic_cheeseburger" as const, modifiers: [] };

describe("recipe evaluation", () => {
  it("scores a well-made classic cheeseburger at 100 with a tip", () => {
    const r = evaluateBurger(perfectClassic(), classic, 30, 180);
    expect(r.score).toBe(100);
    expect(r.accepted).toBe(true);
    expect(r.priceCents).toBe(750);
    expect(r.tipCents).toBeGreaterThan(0);
    expect(r.feedback).toEqual(["Perfect burger!"]);
  });

  it("reports specific missing ingredients", () => {
    const layers = perfectClassic().filter((l) => l.kind !== "cheese");
    const r = evaluateBurger(layers, classic, 0, 180);
    expect(r.feedback).toContain("Missing cheese");
    expect(r.score).toBeLessThan(100);
  });

  it("penalises undercooked and burnt patties", () => {
    const raw = perfectClassic();
    raw[1] = layer("patty", { cookA: 0.3, cookB: 0.0, inner: 0.2, temp: 30 });
    const r = evaluateBurger(raw, classic, 0, 180);
    expect(r.feedback).toContain("Patty was undercooked in the middle");
    expect(r.feedback).toContain("Burger had gone cold");

    const burnt = perfectClassic();
    burnt[1] = layer("patty", { cookA: 1.5, cookB: 0.8, inner: 1.1, burn: 0.6, temp: 80 });
    expect(evaluateBurger(burnt, classic, 0, 180).feedback).toContain("Patty was burnt");
  });

  it("honours removal modifiers", () => {
    const order = { recipe: "classic_cheeseburger" as const, modifiers: ["no_pickle" as const] };
    expect(expectedLayers(order)).not.toContain("pickle");
    const r = evaluateBurger(perfectClassic(), order, 0, 180);
    expect(r.feedback).toContain("Asked for no pickles");
  });

  it("refuses an unclosed, bunless pile", () => {
    const r = evaluateBurger([layer("patty"), layer("cheese")], classic, 0, 180);
    expect(r.accepted).toBe(false);
    expect(r.priceCents).toBe(0);
  });

  it("deducts for long waits", () => {
    const r = evaluateBurger(perfectClassic(), classic, 280, 180);
    expect(r.feedback).toContain("Order waited too long");
  });
});
