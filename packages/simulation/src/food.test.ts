import { describe, expect, it } from "vitest";
import { COOKING } from "@ahb/data";
import { createFoodState, heatFactor, pattyDoneness, stepFood, stepGrillTemp } from "./food.js";

function cook(kind: Parameters<typeof stepFood>[0], seconds: number, temp: number | null, s = createFoodState(kind), below: number | null = null) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) stepFood(kind, s, { contactTemp: temp, belowTemp: below }, dt);
  return s;
}

describe("grill temperature", () => {
  it("approaches the knob target and cools when off", () => {
    let t: number = COOKING.ambientTemp;
    for (let i = 0; i < 60 * 20; i++) t = stepGrillTemp(t, 1, 1 / 60);
    expect(t).toBeGreaterThan(240);
    for (let i = 0; i < 60 * 20; i++) t = stepGrillTemp(t, 0, 1 / 60);
    expect(t).toBeLessThan(30);
  });

  it("has no browning below the onset temperature", () => {
    expect(heatFactor(COOKING.browningOnset - 1)).toBe(0);
    expect(heatFactor(230)).toBeCloseTo(1, 5);
  });
});

describe("patty cooking", () => {
  it("browns only the side in contact with the grill", () => {
    const s = cook("patty", 30, 200);
    expect(s.cookA).toBeGreaterThan(0.5);
    expect(s.cookB).toBeLessThan(0.1);
  });

  it("flipping moves direct heat to the other side", () => {
    const s = cook("patty", 30, 200);
    s.down = 1;
    cook("patty", 30, 200, s);
    expect(s.cookB).toBeGreaterThan(0.5);
    expect(Math.abs(s.cookA - s.cookB)).toBeLessThan(0.15);
  });

  it("cooks through after both sides on medium-high heat", () => {
    const s = cook("patty", 40, 200);
    s.down = 1;
    cook("patty", 40, 200, s);
    expect(s.inner).toBeGreaterThan(0.85);
    expect(s.burn).toBe(0);
    expect(pattyDoneness(s)).toBe("cooked");
  });

  it("burns when left too long on high heat", () => {
    const s = cook("patty", 90, 250);
    expect(s.burn).toBeGreaterThan(0.25);
    expect(pattyDoneness(s)).toBe("burnt");
  });

  it("cools after leaving the grill", () => {
    const s = cook("patty", 40, 220);
    const hot = s.temp;
    cook("patty", 60, null, s);
    expect(s.temp).toBeLessThan(hot - 10);
    expect(s.temp).toBeGreaterThan(COOKING.ambientTemp);
  });
});

describe("cheese and buns", () => {
  it("cheese melts on a hot patty but not on a cold one", () => {
    const melted = cook("cheese", 15, null, createFoodState("cheese"), 75);
    expect(melted.melt).toBeGreaterThan(0.6);
    const cold = cook("cheese", 15, null, createFoodState("cheese"), 10);
    expect(cold.melt).toBe(0);
  });

  it("buns toast on the grill and burn if forgotten", () => {
    const toasted = cook("bun_bottom", 12, 200);
    expect(toasted.toast).toBeGreaterThan(0.4);
    expect(toasted.burn).toBe(0);
    const burnt = cook("bun_top", 60, 250);
    expect(burnt.burn).toBeGreaterThan(0.2);
  });
});
