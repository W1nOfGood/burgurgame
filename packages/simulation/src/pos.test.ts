import { describe, expect, it } from "vitest";
import { compareOrders, speak, totalCents, type WantedOrder } from "./pos.js";

const want = (o: Partial<WantedOrder> = {}): WantedOrder => ({ recipe: "classic_cheeseburger", modifiers: [], drink: "", side: "", ...o });

describe("taking an order", () => {
  it("speaks like a customer", () => {
    expect(speak(want())).toBe("I'll have a Classic Cheeseburger, please.");
    expect(speak(want({ modifiers: ["no_onion", "extra_sauce"], drink: "cola" }))).toBe("I'll have a Classic Cheeseburger, no onions and extra sauce, with a Fizz Cola, please.");
    expect(speak(want({ drink: "cola", side: "fries" }))).toBe("I'll have a Classic Cheeseburger, with fries and a Fizz Cola, please.");
  });

  it("adds up burger, changes, drink and fries", () => {
    expect(totalCents(want())).toBe(750);
    expect(totalCents(want({ modifiers: ["extra_cheese"], drink: "cola", side: "fries" }))).toBe(750 + 75 + 200 + 300);
  });

  it("accepts the same order whatever the order of the changes", () => {
    expect(compareOrders(want({ modifiers: ["no_onion", "no_pickle"] }), want({ modifiers: ["no_pickle", "no_onion"] }))).toEqual([]);
  });

  it("says what is wrong when it is not", () => {
    expect(compareOrders(want(), want({ recipe: "hamburger" }))).toEqual(["That's not the burger I asked for."]);
    expect(compareOrders(want({ modifiers: ["no_onion"] }), want())).toEqual(["You missed: no onions."]);
    expect(compareOrders(want(), want({ modifiers: ["extra_cheese"] }))).toEqual(["I didn't ask for: extra cheese."]);
    expect(compareOrders(want({ drink: "cola" }), want({ drink: "orange" }))).toEqual(["That's not the drink I asked for."]);
    expect(compareOrders(want(), want({ drink: "cola" }))).toEqual(["I didn't order a drink."]);
    expect(compareOrders(want({ side: "fries" }), want())).toEqual(["Where are my fries?"]);
  });
});
