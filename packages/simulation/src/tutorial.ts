import { CHILLER_DRAWER, DISPENSERS, GRILL_ZONES, PICKUP_POINT, REGISTER, SHIFT_SWITCH, SODA_FOUNTAIN, drinkById, type DrinkId } from "@ahb/data";

/**
 * The starting tutorial: one Starter Burger (bun, patty, bun) and a cola, from flipping the OPEN
 * sign to handing it over. The coach never keeps its own progress: every frame the step is
 * derived from the kitchen's state, so it follows whatever the player does, in any order, and a
 * rejoining player lands on the right step.
 */
export interface TutorialItem {
  id: string;
  kind: string;
  /** Id of the stack's root ("" for a root itself). */
  root: string;
  holder: string;
  zone: number;
  x: number;
  y: number;
  z: number;
  cookA: number;
  cookB: number;
  inner: number;
  /** Cups: drink code and fill 0..1. */
  drink: number;
  level: number;
}

export interface TutorialView {
  me: string;
  phase: string;
  drawer: number;
  knobs: number[];
  customers: { phase: string }[];
  /** Open tickets: the drink they came with. */
  openOrders: { recipe: string; drink: string }[];
  items: TutorialItem[];
}

export interface TutorialStep {
  id: string;
  /** 1-based position, for "step 4 of 12". */
  index: number;
  text: string;
  /** Where to point, in world metres. */
  target: readonly [number, number, number] | null;
}

export const TUTORIAL_STEP_COUNT = 12;

const COOKED_INNER = 0.8;
const SEARED = 0.45;

const grillCentre = (): [number, number, number] => {
  const r = GRILL_ZONES[1]!.rect;
  return [(r.minX + r.maxX) / 2, GRILL_ZONES[1]!.y + 0.05, (r.minZ + r.maxZ) / 2];
};

export function tutorialStep(v: TutorialView): TutorialStep {
  const step = (index: number, id: string, text: string, target: readonly [number, number, number] | null): TutorialStep => ({ id, index, text, target });
  if (v.phase === "prep") {
    return step(1, "open", "Welcome to After Hours! Aim at the OPEN sign switch on the counter wall and press E to open up.", SHIFT_SWITCH);
  }
  const ordering = v.customers.some((c) => c.phase === "ordering");
  const ticket = v.openOrders[0];
  if (!ticket) {
    if (ordering) return step(3, "order", "A customer is at the counter. Walk to the cash register (west end of the counter) and press E to take their order.", REGISTER);
    return step(2, "wait", "Your first customer is walking in…", null);
  }

  const patties = v.items.filter((i) => i.kind === "patty");
  // The patty furthest along is the one being cooked.
  const patty = [...patties].sort((a, b) => b.cookA + b.cookB + b.inner - (a.cookA + a.cookB + a.inner))[0];
  const tray = v.items.find((i) => i.kind === "tray" && i.root === "" && v.items.some((c) => c.root === i.id));
  const stackKinds = tray ? v.items.filter((i) => i.root === tray.id) : [];
  const has = (kind: string) => stackKinds.some((i) => i.kind === kind);
  const cooked = !!patty && patty.inner >= COOKED_INNER && patty.cookA >= SEARED;
  const burgerClosed = has("bun_bottom") && has("patty") && has("bun_top");

  if (!patty && !burgerClosed) {
    if (v.drawer < 0.55) {
      const h = CHILLER_DRAWER.handle;
      return step(4, "drawer", "Time to cook. Open the chiller drawer under the prep counter: press and drag its handle toward you.", [h[0], h[1], h[2]]);
    }
    const d = DISPENSERS.find((x) => x.id === "drawer_patty")!;
    return step(4, "patty", "Take a beef patty from the open drawer (aim at it and click).", [d.center[0], d.center[1], CHILLER_DRAWER.handle[2] - v.drawer * CHILLER_DRAWER.travel + 0.15]);
  }

  if (!burgerClosed) {
    if (patty && patty.zone < 0 && !cooked && !has("patty")) {
      return step(5, "grill", "Put the patty on the middle of the grill.", grillCentre());
    }
    if (patty && patty.zone >= 0 && !cooked) {
      const knob = v.knobs[patty.zone] ?? 0;
      if (knob < 0.2) {
        const k = GRILL_ZONES[patty.zone]!.knob;
        return step(6, "knob", "The grill is cold. Turn the knob under the patty up (drag it, or click it).", [k[0], k[1], k[2]]);
      }
      if (patty.cookA < SEARED) return step(7, "sear", "Sizzling! Give it a moment to brown on the bottom…", [patty.x, patty.y, patty.z]);
      if (patty.cookB < 0.2) {
        return step(8, "flip", "Brown on the bottom. Grab a spatula from the island, aim at the patty and press E to flip it.", [patty.x, patty.y, patty.z]);
      }
      return step(9, "finish", "Flipped! Wait until it is cooked through.", [patty.x, patty.y, patty.z]);
    }
    // Cooked (or still in hand): build.
    if (!tray || !has("bun_bottom")) {
      const t = DISPENSERS.find((x) => x.kind === "tray")!;
      return step(10, "bun", "Build the burger: take a tray from the stack by the island, then a bottom bun onto it.", [t.center[0], t.center[1], t.center[2]]);
    }
    if (!has("patty")) {
      return step(10, "patty_on", cooked ? "Slide the cooked patty onto the bun (use the spatula to lift it)." : "Wait for the patty to cook through, then slide it onto the bun.", [tray.x, tray.y + 0.1, tray.z]);
    }
    return step(10, "top", "Finish with a top bun. A burger must be closed to be served.", [tray.x, tray.y + 0.15, tray.z]);
  }

  // The burger is built; the ticket comes with a drink.
  const drink = ticket.drink ? drinkById(ticket.drink as DrinkId) : undefined;
  const cups = v.items.filter((i) => i.kind === "cup");
  const full = cups.find((c) => c.drink > 0 && c.level >= SODA_FOUNTAIN.fullAt);
  if (drink && !full) {
    const valve = ticket.drink === "cola" ? 5 : 0;
    const under = cups.find((c) => c.zone === -1 && c.level > 0 && c.level < SODA_FOUNTAIN.fullAt);
    if (under) return step(11, "pour", `Filling… hold on a moment.`, [under.x, under.y + 0.1, under.z]);
    return step(11, "cup", `The ticket comes with a ${drink.label}. Take a paper cup from the stack by the fountain and set it on the tray under the valve (${drink.label}).`, [SODA_FOUNTAIN.valveX[valve]!, SODA_FOUNTAIN.trayY + 0.1, 1.2]);
  }
  return step(12, "serve", "Done! Set the tray on the pickup shelf under the heat lamp" + (drink ? " and the full cup beside it." : "."), [PICKUP_POINT[0], 1.05, 0.0]);
}
