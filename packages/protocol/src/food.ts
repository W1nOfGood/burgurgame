import { FOOD_BYTE_RANGE, fromByte, toByte, type FoodState } from "@ahb/simulation";
import type { ItemState } from "./state.js";

/** Writes authoritative food floats into the replicated byte fields (only on change). */
export function writeFoodBytes(item: ItemState, s: FoodState): void {
  const set = <K extends keyof ItemState>(key: K, value: ItemState[K]) => {
    if (item[key] !== value) item[key] = value;
  };
  set("cookA", toByte(s.cookA, FOOD_BYTE_RANGE.cook));
  set("cookB", toByte(s.cookB, FOOD_BYTE_RANGE.cook));
  set("inner", toByte(s.inner, FOOD_BYTE_RANGE.inner));
  set("burn", toByte(s.burn, FOOD_BYTE_RANGE.burn));
  set("temp", toByte(s.temp, FOOD_BYTE_RANGE.temp));
  set("moisture", toByte(s.moisture, FOOD_BYTE_RANGE.moisture));
  set("melt", toByte(s.melt, FOOD_BYTE_RANGE.melt));
  set("toast", toByte(s.toast, FOOD_BYTE_RANGE.toast));
  set("sauce", toByte(s.sauce, FOOD_BYTE_RANGE.sauce));
  set("down", s.down);
  set("dirty", s.dirty);
}

/** Reads replicated bytes back into a FoodState (client presentation, tests). */
export function readFoodBytes(item: Pick<ItemState, "cookA" | "cookB" | "inner" | "burn" | "temp" | "moisture" | "melt" | "toast" | "sauce" | "down" | "dirty">): FoodState {
  return {
    cookA: fromByte(item.cookA, FOOD_BYTE_RANGE.cook),
    cookB: fromByte(item.cookB, FOOD_BYTE_RANGE.cook),
    inner: fromByte(item.inner, FOOD_BYTE_RANGE.inner),
    burn: fromByte(item.burn, FOOD_BYTE_RANGE.burn),
    temp: fromByte(item.temp, FOOD_BYTE_RANGE.temp),
    moisture: fromByte(item.moisture, FOOD_BYTE_RANGE.moisture),
    melt: fromByte(item.melt, FOOD_BYTE_RANGE.melt),
    toast: fromByte(item.toast, FOOD_BYTE_RANGE.toast),
    sauce: fromByte(item.sauce, FOOD_BYTE_RANGE.sauce),
    down: item.down === 1 ? 1 : 0,
    dirty: item.dirty,
    age: 0,
  };
}
