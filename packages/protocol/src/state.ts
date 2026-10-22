import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * Replicated restaurant state (spec §14: compact poses, state changes, ownership, recipe
 * layers, cooking parameters, equipment values). Cooking values are quantised to bytes by the
 * server so a patch is only produced when the visible state actually changes.
 *
 * Field order is part of the wire format: append new fields at the end of a schema.
 */

export const PlayerState = schema(
  {
    name: t.string(),
    color: t.uint8(),
    /** "desktop" | "touch" */
    platform: t.string(),
    x: t.float32(),
    y: t.float32(),
    z: t.float32(),
    vx: t.float32(),
    vy: t.float32(),
    vz: t.float32(),
    yaw: t.float32(),
    pitch: t.float32(),
    crouch: t.boolean(),
    /** Last input sample sequence the server has simulated for this player. */
    ack: t.uint32(),
    /** Root item id currently held, or "". */
    held: t.string(),
    connected: t.boolean(),
    admin: t.boolean(),
    /** Hold distance of the held item, for remote presentation. */
    hold: t.float32(),
    /** True while the player is in a menu (presentation only; never pauses co-op). */
    away: t.boolean(),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const ItemState = schema(
  {
    kind: t.string(),
    x: t.float32(),
    y: t.float32(),
    z: t.float32(),
    qx: t.float32(),
    qy: t.float32(),
    qz: t.float32(),
    qw: t.float32().default(1),
    /** Incremented on every ownership or stacking change; clients echo it on grab. */
    rev: t.uint32(),
    /** Session id of the player holding this item (roots only), or "". */
    holder: t.string(),
    /** Id of the item directly beneath in a logical stack, or "" for a physical root. */
    on: t.string(),
    /** Grill zone in direct contact, or -1. */
    zone: t.int8().default(-1),
    cookA: t.uint8(),
    cookB: t.uint8(),
    inner: t.uint8(),
    burn: t.uint8(),
    temp: t.uint8(),
    moisture: t.uint8().default(255),
    melt: t.uint8(),
    toast: t.uint8(),
    sauce: t.uint8(),
    down: t.uint8(),
    dirty: t.boolean(),
    /** Assisted flip progress 1..255 while flipping, 0 otherwise. */
    flip: t.uint8(),
    /** Offered to teammates by its holder. */
    offered: t.boolean(),
    /** Sauce bottle fill level 0..255. */
    level: t.uint8(),
    /** Layer index within its stack (0 = root). */
    layer: t.uint8(),
    /** Root id of the stack this item belongs to ("" when it is a root itself). */
    root: t.string(),
  },
  "ItemState",
);
export type ItemState = SchemaType<typeof ItemState>;

export const GrillZoneState = schema(
  {
    knob: t.float32(),
    /** Surface temperature in °C (fictional), 0..255. */
    temp: t.uint8(),
  },
  "GrillZoneState",
);
export type GrillZoneState = SchemaType<typeof GrillZoneState>;

export const OrderState = schema(
  {
    number: t.uint16(),
    recipe: t.string(),
    modifiers: t.array("string"),
    /** Shift time (seconds) when the ticket printed. */
    createdAt: t.float32(),
    /** "open" | "served" | "refused" | "cancelled" */
    status: t.string(),
    score: t.uint8(),
  },
  "OrderState",
);
export type OrderState = SchemaType<typeof OrderState>;

export const RestaurantState = schema(
  {
    protocol: t.uint16(),
    name: t.string(),
    /** "prep" | "open" | "closing" | "summary" */
    phase: t.string(),
    /** "relaxed" | "normal" */
    mode: t.string(),
    paused: t.boolean(),
    pauseReason: t.string(),
    /** Server tick at which a resume countdown finishes, 0 when none. */
    resumeTick: t.uint32(),
    /** Authoritative fixed-step counter (60 Hz). Drives client interpolation clocks. */
    tick: t.uint32(),
    /** Simulated seconds since the shift opened. */
    shiftTime: t.float32(),
    balance: t.int32(),
    revenue: t.int32(),
    costs: t.int32(),
    waste: t.int32(),
    served: t.uint16(),
    nextOrder: t.uint16(),
    /** "ok" | "pending" | "unavailable" */
    saveStatus: t.string(),
    drawer: t.float32(),
    shiftSwitch: t.boolean(),
    players: t.map(PlayerState),
    items: t.map(ItemState),
    grill: t.array(GrillZoneState),
    orders: t.map(OrderState),
    stock: t.map("uint16"),
    /** Session ids voting for a co-op pause. */
    pauseVotes: t.array("string"),
  },
  "RestaurantState",
);
export type RestaurantState = SchemaType<typeof RestaurantState>;
