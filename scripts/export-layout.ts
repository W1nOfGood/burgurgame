// Writes assets/source/layout.json from packages/data so Blender builds geometry that matches
// server collision exactly:  npx tsx --conditions=source scripts/export-layout.ts
import { writeFileSync } from "node:fs";
import { BOXES, CHILLER_DRAWER, DISPENSERS, GRILL_ZONES, INITIAL_ITEMS, ITEMS, NO_PLACE_RECTS, PICKUP_ZONE, ROOM_BOUNDS, SHIFT_SWITCH, TRASH_ZONE } from "@ahb/data";

const data = { BOXES, CHILLER_DRAWER, DISPENSERS, GRILL_ZONES, INITIAL_ITEMS, ITEMS, NO_PLACE_RECTS, PICKUP_ZONE, ROOM_BOUNDS, SHIFT_SWITCH, TRASH_ZONE };
writeFileSync(new URL("../assets/source/layout.json", import.meta.url), JSON.stringify(data, null, 1));
console.log("wrote assets/source/layout.json");
