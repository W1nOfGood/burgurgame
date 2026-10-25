import { describe, expect, it } from "vitest";
import { TUTORIAL_STEP_COUNT, tutorialStep, type TutorialItem, type TutorialView } from "./tutorial.js";

const item = (o: Partial<TutorialItem> & { id: string; kind: string }): TutorialItem => ({ root: "", holder: "", zone: -1, x: 0, y: 1, z: 2, cookA: 0, cookB: 0, inner: 0, drink: 0, level: 0, ...o });
const view = (o: Partial<TutorialView> = {}): TutorialView => ({ me: "me", phase: "open", drawer: 0, knobs: [0, 0, 0], customers: [], openOrders: [], items: [], ...o });
const ticket = { recipe: "starter", drink: "cola" };
const id = (o: Partial<TutorialView>) => tutorialStep(view(o)).id;

describe("the tutorial coach", () => {
  it("starts with the OPEN sign and waits for the customer", () => {
    expect(id({ phase: "prep" })).toBe("open");
    expect(id({})).toBe("wait");
    expect(id({ customers: [{ phase: "arriving" }] })).toBe("wait");
  });

  it("sends you to the register when someone is ready to order", () => {
    const s = tutorialStep(view({ customers: [{ phase: "ordering" }] }));
    expect(s.id).toBe("order");
    expect(s.target).not.toBeNull();
  });

  it("walks the patty from the drawer to the grill to the flip", () => {
    const o = { openOrders: [ticket] };
    expect(id({ ...o })).toBe("drawer");
    expect(id({ ...o, drawer: 0.9 })).toBe("patty");
    expect(id({ ...o, items: [item({ id: "p", kind: "patty" })] })).toBe("grill");
    expect(id({ ...o, items: [item({ id: "p", kind: "patty", zone: 1 })], knobs: [0, 0, 0] })).toBe("knob");
    expect(id({ ...o, items: [item({ id: "p", kind: "patty", zone: 1 })], knobs: [0, 0.6, 0] })).toBe("sear");
    expect(id({ ...o, items: [item({ id: "p", kind: "patty", zone: 1, cookA: 0.6 })], knobs: [0, 0.6, 0] })).toBe("flip");
    expect(id({ ...o, items: [item({ id: "p", kind: "patty", zone: 1, cookA: 0.7, cookB: 0.3, inner: 0.5 })], knobs: [0, 0.6, 0] })).toBe("finish");
  });

  it("builds the burger from what is on the tray", () => {
    const cooked = item({ id: "p", kind: "patty", cookA: 0.8, cookB: 0.8, inner: 0.9 });
    const o = { openOrders: [ticket], drawer: 0.9 };
    expect(id({ ...o, items: [cooked] })).toBe("bun");
    const tray = item({ id: "t", kind: "tray" });
    const bun = item({ id: "b", kind: "bun_bottom", root: "t" });
    expect(id({ ...o, items: [cooked, tray, bun] })).toBe("patty_on");
    expect(id({ ...o, items: [tray, bun, { ...cooked, root: "t" }] })).toBe("top");
  });

  it("asks for the drink once the burger is closed, then for the shelf", () => {
    const stack = [item({ id: "t", kind: "tray" }), item({ id: "b", kind: "bun_bottom", root: "t" }), item({ id: "p", kind: "patty", root: "t", cookA: 0.8, cookB: 0.8, inner: 0.9 }), item({ id: "u", kind: "bun_top", root: "t" })];
    const o = { openOrders: [ticket] };
    expect(id({ ...o, items: stack })).toBe("cup");
    expect(id({ ...o, items: [...stack, item({ id: "c", kind: "cup", drink: 6, level: 0.4 })] })).toBe("pour");
    const s = tutorialStep(view({ ...o, items: [...stack, item({ id: "c", kind: "cup", drink: 6, level: 1 })] }));
    expect(s.id).toBe("serve");
    expect(s.index).toBe(TUTORIAL_STEP_COUNT);
  });

  it("follows the player when they do things out of order", () => {
    // Burger already built before the patty was ever flipped: no going back to the grill.
    const stack = [item({ id: "t", kind: "tray" }), item({ id: "b", kind: "bun_bottom", root: "t" }), item({ id: "p", kind: "patty", root: "t" }), item({ id: "u", kind: "bun_top", root: "t" })];
    expect(id({ openOrders: [{ recipe: "starter", drink: "" }], items: stack })).toBe("serve");
  });
});
