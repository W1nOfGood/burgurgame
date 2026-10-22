// Regenerates docs/RECIPES.md from packages/data:  npx tsx --conditions=source scripts/recipes-md.ts
import { writeFileSync } from "node:fs";
import { ITEMS, MODIFIERS, RECIPES, SAUCE_LABEL, formatCents, type ItemKind } from "@ahb/data";

const names: Partial<Record<ItemKind, string>> = { patty: "Beef patty", cheese: "Cheddar", swiss: "Swiss", bun_bottom: "Bottom bun", bun_top: "Top bun" };
const lines = [
  "# The menu",
  "",
  "Generated from `packages/data/src/recipes.ts` by `scripts/recipes-md.ts` — edit the data, not this file.",
  "",
  "Tickets in the game show only the burger's name; cooks are expected to learn these builds.",
  "Layers are listed **bottom to top** and must be stacked in this order. A burger must carry",
  "exactly the listed sauces (any layer). Tier 1 is on the menu from the start of a shift; tier 2",
  "and tier 3 unlock as the night gets busier.",
  "",
];
for (const tier of [1, 2, 3]) {
  lines.push(`## Tier ${tier}`, "");
  for (const r of Object.values(RECIPES).filter((x) => x.enabled && x.tier === tier)) {
    const layers = r.layers.map((k) => `${names[k] ?? ITEMS[k].label}${r.grilled?.includes(k) ? " (grilled)" : ""}`);
    lines.push(`### ${r.label} — ${formatCents(r.priceCents)}`, "", `_${r.blurb}_`, "", `- **Build:** ${layers.join(" → ")}`, `- **Sauces:** ${r.sauces.map((s) => SAUCE_LABEL[s]).join(" + ") || "none"}`, "");
  }
}
lines.push("## Modifiers", "", "| Ticket says | Means |", "| --- | --- |");
for (const m of Object.values(MODIFIERS).filter((x) => x.enabled)) {
  const means = m.remove ? `leave out ${ITEMS[m.remove].label.toLowerCase()}` : m.add ? `add ${ITEMS[m.add].label.toLowerCase()} right after the ${m.after ? ITEMS[m.after].label.toLowerCase() : "fillings"}` : "about double the usual sauce";
  lines.push(`| ${m.label} | ${means}${m.priceDeltaCents ? ` (+${formatCents(m.priceDeltaCents)})` : ""} |`);
}
lines.push("");
writeFileSync(new URL("../docs/RECIPES.md", import.meta.url), lines.join("\n"));
console.log("wrote docs/RECIPES.md");
