export const ITEM_KINDS = [
  "patty",
  "bun_bottom",
  "bun_top",
  "cheese",
  "lettuce",
  "tomato",
  "onion",
  "pickle",
  "tray",
  "spatula",
  "sauce_bottle",
  "bacon",
  "mushroom",
  "egg",
  "jalapeno",
  "swiss",
  "veggie_patty",
  "ketchup_bottle",
  "mustard_bottle",
  "mayo_bottle",
  "bbq_bottle",
] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

export type ItemShape =
  | { type: "cylinder"; radius: number; halfHeight: number }
  | { type: "box"; half: readonly [number, number, number] };

export type GripPose = "pinch" | "flat" | "tool" | "bottle" | "tray";

export const SAUCE_KINDS = ["house", "ketchup", "mustard", "mayo", "bbq"] as const;
export type SauceKind = (typeof SAUCE_KINDS)[number];

/** Bit per sauce in a layer's sauce mask. */
export const SAUCE_BIT: Record<SauceKind, number> = { house: 1, ketchup: 2, mustard: 4, mayo: 8, bbq: 16 };

export const SAUCE_LABEL: Record<SauceKind, string> = {
  house: "house sauce",
  ketchup: "ketchup",
  mustard: "mustard",
  mayo: "mayo",
  bbq: "BBQ sauce",
};

export function saucesInMask(mask: number): SauceKind[] {
  return SAUCE_KINDS.filter((k) => (mask & SAUCE_BIT[k]) !== 0);
}

export interface ItemDef {
  kind: ItemKind;
  label: string;
  shape: ItemShape;
  /** Height this item adds to a logical stack. */
  layerHeight: number;
  mass: number;
  food: boolean;
  tool: boolean;
  grip: GripPose;
  /** Cost in cents when taken from stock; 0 for reusable equipment. */
  costCents: number;
  /** Items of these kinds may be stacked directly on top of this item. */
  accepts: readonly ItemKind[];
  /** Squeeze bottles: which sauce they dispense. */
  sauce?: SauceKind;
  /** Food that should be cooked on the grill before serving. */
  grillable?: boolean;
}

const FOOD_LAYERS: readonly ItemKind[] = [
  "patty",
  "veggie_patty",
  "bun_top",
  "cheese",
  "swiss",
  "lettuce",
  "tomato",
  "onion",
  "pickle",
  "bacon",
  "mushroom",
  "egg",
  "jalapeno",
];

const SPATULA_LOADS: readonly ItemKind[] = ["patty", "veggie_patty", "bun_bottom", "bun_top", "bacon", "egg", "mushroom", "onion"];

function bottle(kind: ItemKind, label: string, sauce: SauceKind): ItemDef {
  return {
    kind,
    label,
    shape: { type: "cylinder", radius: 0.03, halfHeight: 0.09 },
    layerHeight: 0.18,
    mass: 0.35,
    food: false,
    tool: true,
    grip: "bottle",
    costCents: 0,
    accepts: [],
    sauce,
  };
}

export const ITEMS: Record<ItemKind, ItemDef> = {
  patty: {
    kind: "patty",
    label: "Patty",
    shape: { type: "cylinder", radius: 0.055, halfHeight: 0.012 },
    layerHeight: 0.024,
    mass: 0.12,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 90,
    accepts: FOOD_LAYERS,
    grillable: true,
  },
  bun_bottom: {
    kind: "bun_bottom",
    label: "Bottom bun",
    shape: { type: "cylinder", radius: 0.06, halfHeight: 0.016 },
    layerHeight: 0.032,
    mass: 0.04,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 20,
    accepts: FOOD_LAYERS,
  },
  bun_top: {
    kind: "bun_top",
    label: "Top bun",
    shape: { type: "cylinder", radius: 0.06, halfHeight: 0.024 },
    layerHeight: 0.048,
    mass: 0.04,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 20,
    accepts: [],
  },
  cheese: {
    kind: "cheese",
    label: "Cheese slice",
    shape: { type: "box", half: [0.045, 0.002, 0.045] },
    layerHeight: 0.004,
    mass: 0.02,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 25,
    accepts: FOOD_LAYERS,
  },
  lettuce: {
    kind: "lettuce",
    label: "Lettuce",
    shape: { type: "cylinder", radius: 0.06, halfHeight: 0.005 },
    layerHeight: 0.01,
    mass: 0.01,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 10,
    accepts: FOOD_LAYERS,
  },
  tomato: {
    kind: "tomato",
    label: "Tomato slice",
    shape: { type: "cylinder", radius: 0.04, halfHeight: 0.005 },
    layerHeight: 0.01,
    mass: 0.015,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 12,
    accepts: FOOD_LAYERS,
  },
  onion: {
    kind: "onion",
    label: "Onions",
    shape: { type: "cylinder", radius: 0.04, halfHeight: 0.004 },
    layerHeight: 0.008,
    mass: 0.01,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 8,
    accepts: FOOD_LAYERS,
  },
  pickle: {
    kind: "pickle",
    label: "Pickles",
    shape: { type: "cylinder", radius: 0.035, halfHeight: 0.003 },
    layerHeight: 0.006,
    mass: 0.008,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 6,
    accepts: FOOD_LAYERS,
  },
  tray: {
    kind: "tray",
    label: "Tray",
    shape: { type: "box", half: [0.2, 0.01, 0.15] },
    layerHeight: 0.02,
    mass: 0.4,
    food: false,
    tool: false,
    grip: "tray",
    costCents: 0,
    accepts: ["bun_bottom"],
  },
  spatula: {
    kind: "spatula",
    label: "Spatula",
    shape: { type: "box", half: [0.05, 0.008, 0.16] },
    layerHeight: 0.016,
    mass: 0.25,
    food: false,
    tool: true,
    grip: "tool",
    costCents: 0,
    /** A spatula carries one grill item on its blade. */
    accepts: SPATULA_LOADS,
  },
  sauce_bottle: bottle("sauce_bottle", "House sauce", "house"),
  ketchup_bottle: bottle("ketchup_bottle", "Ketchup", "ketchup"),
  mustard_bottle: bottle("mustard_bottle", "Mustard", "mustard"),
  mayo_bottle: bottle("mayo_bottle", "Mayo", "mayo"),
  bbq_bottle: bottle("bbq_bottle", "BBQ sauce", "bbq"),
  bacon: {
    kind: "bacon",
    label: "Bacon",
    shape: { type: "box", half: [0.075, 0.003, 0.022] },
    layerHeight: 0.006,
    mass: 0.02,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 30,
    accepts: FOOD_LAYERS,
    grillable: true,
  },
  mushroom: {
    kind: "mushroom",
    label: "Sliced mushrooms",
    shape: { type: "cylinder", radius: 0.045, halfHeight: 0.006 },
    layerHeight: 0.012,
    mass: 0.02,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 20,
    accepts: FOOD_LAYERS,
    grillable: true,
  },
  egg: {
    kind: "egg",
    label: "Egg",
    shape: { type: "cylinder", radius: 0.05, halfHeight: 0.006 },
    layerHeight: 0.012,
    mass: 0.05,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 25,
    accepts: FOOD_LAYERS,
    grillable: true,
  },
  jalapeno: {
    kind: "jalapeno",
    label: "Jalapeños",
    shape: { type: "cylinder", radius: 0.035, halfHeight: 0.003 },
    layerHeight: 0.006,
    mass: 0.008,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 8,
    accepts: FOOD_LAYERS,
  },
  swiss: {
    kind: "swiss",
    label: "Swiss cheese",
    shape: { type: "box", half: [0.045, 0.002, 0.045] },
    layerHeight: 0.004,
    mass: 0.02,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 30,
    accepts: FOOD_LAYERS,
  },
  veggie_patty: {
    kind: "veggie_patty",
    label: "Veggie patty",
    shape: { type: "cylinder", radius: 0.055, halfHeight: 0.013 },
    layerHeight: 0.026,
    mass: 0.11,
    food: true,
    tool: false,
    grip: "pinch",
    costCents: 70,
    accepts: FOOD_LAYERS,
    grillable: true,
  },
};

export function isSauceBottle(kind: ItemKind): boolean {
  return ITEMS[kind].sauce !== undefined;
}

export function isCheese(kind: ItemKind): boolean {
  return kind === "cheese" || kind === "swiss";
}

export function isPatty(kind: ItemKind): boolean {
  return kind === "patty" || kind === "veggie_patty";
}

export function isItemKind(value: unknown): value is ItemKind {
  return typeof value === "string" && (ITEM_KINDS as readonly string[]).includes(value);
}
