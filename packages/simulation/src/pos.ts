import { DRINKS_ENABLED, FRIES_ENABLED, MODIFIERS, RECIPES, drinkById, modifiersFor, type DrinkId, type ModifierId, type RecipeId } from "@ahb/data";

/**
 * Taking an order at the register. A customer wants one burger (with changes), maybe a drink and
 * fries. The cashier rings up what they heard; the ticket prints only when it matches.
 */
export interface WantedOrder {
  recipe: RecipeId;
  /** Order does not matter. */
  modifiers: readonly ModifierId[];
  drink: DrinkId | "";
  side: "fries" | "";
}

/** What the customer says at the counter. */
export function speak(w: WantedOrder): string {
  const parts: string[] = [`a ${RECIPES[w.recipe].label}`];
  for (const m of w.modifiers) parts.push(MODIFIERS[m].label.toLowerCase());
  const extras: string[] = [];
  if (w.side) extras.push("fries");
  if (w.drink) extras.push(`a ${drinkById(w.drink)?.label ?? w.drink}`);
  const burger = parts.length > 1 ? `${parts[0]}, ${parts.slice(1).join(" and ")}` : parts[0]!;
  return `I'll have ${burger}${extras.length ? `, with ${extras.join(" and ")}` : ""}, please.`;
}

/** The ticket total before any tip: burger, changes, drink and fries. */
export function totalCents(w: WantedOrder): number {
  let c = RECIPES[w.recipe].priceCents;
  for (const m of w.modifiers) c += MODIFIERS[m].priceDeltaCents;
  if (w.drink) c += drinkById(w.drink)?.priceCents ?? 0;
  if (w.side) c += 300;
  return c;
}

/** Why the rung-up order is not what they asked for (empty when it matches). */
export function compareOrders(want: WantedOrder, rung: WantedOrder): string[] {
  const problems: string[] = [];
  if (want.recipe !== rung.recipe) problems.push("That's not the burger I asked for.");
  const a = [...want.modifiers].sort().join(",");
  const b = [...rung.modifiers].sort().join(",");
  if (want.recipe === rung.recipe && a !== b) {
    const missing = want.modifiers.filter((m) => !rung.modifiers.includes(m));
    const extra = rung.modifiers.filter((m) => !want.modifiers.includes(m));
    if (missing.length) problems.push(`You missed: ${missing.map((m) => MODIFIERS[m].label.toLowerCase()).join(", ")}.`);
    if (extra.length) problems.push(`I didn't ask for: ${extra.map((m) => MODIFIERS[m].label.toLowerCase()).join(", ")}.`);
  }
  if (want.drink !== rung.drink) problems.push(want.drink ? "That's not the drink I asked for." : "I didn't order a drink.");
  if (want.side !== rung.side) problems.push(want.side ? "Where are my fries?" : "I didn't order fries.");
  return problems;
}

/** Modifiers the till offers for a burger. */
export function modifiersOffered(recipe: RecipeId): ModifierId[] {
  return modifiersFor(recipe);
}

/** Whether the till sells drinks and sides yet. */
export const TILL_HAS = { drinks: DRINKS_ENABLED, fries: FRIES_ENABLED } as const;
