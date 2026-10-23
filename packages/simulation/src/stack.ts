import { INTERACTION, ITEMS, type ItemKind } from "@ahb/data";

/**
 * Burgers are logical layers, not towers of rigid bodies (spec §6). A stack has one physical
 * root (tray, spatula, or a loose food item); everything above it is positioned from the root
 * plus accumulated layer heights.
 */
export function canStackOn(base: ItemKind, item: ItemKind): boolean {
  return ITEMS[base].accepts.includes(item);
}

/** Validates adding `item` on top of a stack whose kinds (bottom → top) are given. */
export function canAddToStack(stackKinds: readonly ItemKind[], item: ItemKind): { ok: true } | { ok: false; reason: string } {
  const top = stackKinds[stackKinds.length - 1];
  if (top === undefined) return { ok: false, reason: "Nothing to stack on" };
  if (stackKinds.length >= INTERACTION.maxStackLayers) return { ok: false, reason: "That stack is too tall" };
  if (top === "bun_top") return { ok: false, reason: "The burger is already closed" };
  if (stackKinds[0] === "spatula" && stackKinds.length > 1) return { ok: false, reason: "The spatula is already carrying something" };
  if (!canStackOn(top, item)) {
    if (top === "tray") return { ok: false, reason: "Start the burger with a bottom bun" };
    return { ok: false, reason: `Can't put ${ITEMS[item].label.toLowerCase()} on ${ITEMS[top].label.toLowerCase()}` };
  }
  return { ok: true };
}

/** Height of the top face of a root item, measured from the root's centre. */
export function rootTopOffset(kind: ItemKind): number {
  return ITEMS[kind].layerHeight / 2;
}

/**
 * Vertical centre offsets for every layer of a stack relative to the root's centre.
 * Index 0 is the root (offset 0).
 */
export function stackOffsets(kinds: readonly ItemKind[]): number[] {
  const out: number[] = [];
  let top = 0;
  kinds.forEach((kind, i) => {
    if (i === 0) {
      out.push(0);
      top = rootTopOffset(kind);
      return;
    }
    const h = ITEMS[kind].layerHeight;
    out.push(top + h / 2);
    top += h;
  });
  return out;
}

/** Total height of a stack above the root's centre. */
export function stackTop(kinds: readonly ItemKind[]): number {
  if (kinds.length === 0) return 0;
  let top = rootTopOffset(kinds[0]!);
  for (let i = 1; i < kinds.length; i++) top += ITEMS[kinds[i]!].layerHeight;
  return top;
}

/** Height from the supporting surface to the root's centre. */
export function restingHeight(kind: ItemKind): number {
  const shape = ITEMS[kind].shape;
  return shape.type === "cylinder" ? shape.halfHeight : shape.half[1];
}

/** Rough horizontal footprint radius used for overlap checks and placement assistance. */
export function footprintRadius(kind: ItemKind): number {
  const shape = ITEMS[kind].shape;
  return shape.type === "cylinder" ? shape.radius : Math.hypot(shape.half[0], shape.half[2]);
}
