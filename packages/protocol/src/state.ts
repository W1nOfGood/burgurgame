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
    name: t.string().default(""),
    color: t.uint8().default(0),
    /** "desktop" | "touch" */
    platform: t.string().default(""),
    /**
     * Motor state at full precision: the owning client resets its prediction to exactly this
     * and replays its unacknowledged input, so any rounding here would come back as a
     * correction (centimetres where the capsule slides along a wall).
     */
    x: t.float64().default(0),
    y: t.float64().default(0),
    z: t.float64().default(0),
    vx: t.float64().default(0),
    vy: t.float64().default(0),
    vz: t.float64().default(0),
    yaw: t.float32().default(0),
    pitch: t.float32().default(0),
    crouch: t.boolean().default(false),
    /** Last input sample sequence the server has simulated for this player. */
    ack: t.uint32().default(0),
    /** Root item id currently held, or "". */
    held: t.string().default(""),
    connected: t.boolean().default(false),
    admin: t.boolean().default(false),
    /** Hold distance of the held item, for remote presentation. */
    hold: t.float32().default(0),
    /** True while the player is in a menu (presentation only; never pauses co-op). */
    away: t.boolean().default(false),
    /** Motor ground contact after the last simulated sample (part of the state prediction resets to). */
    grounded: t.boolean().default(true),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const ItemState = schema(
  {
    kind: t.string().default(""),
    x: t.float32().default(0),
    y: t.float32().default(0),
    z: t.float32().default(0),
    qx: t.float32().default(0),
    qy: t.float32().default(0),
    qz: t.float32().default(0),
    qw: t.float32().default(1),
    /** Incremented on every ownership or stacking change; clients echo it on grab. */
    rev: t.uint32().default(0),
    /** Session id of the player holding this item (roots only), or "". */
    holder: t.string().default(""),
    /** Id of the item directly beneath in a logical stack, or "" for a physical root. */
    on: t.string().default(""),
    /** Grill zone in direct contact, or -1. */
    zone: t.int8().default(-1),
    cookA: t.uint8().default(0),
    cookB: t.uint8().default(0),
    inner: t.uint8().default(0),
    burn: t.uint8().default(0),
    temp: t.uint8().default(0),
    moisture: t.uint8().default(255),
    melt: t.uint8().default(0),
    toast: t.uint8().default(0),
    sauce: t.uint8().default(0),
    down: t.uint8().default(0),
    dirty: t.boolean().default(false),
    /** Assisted flip progress 1..255 while flipping, 0 otherwise. */
    flip: t.uint8().default(0),
    /** Offered to teammates by its holder. */
    offered: t.boolean().default(false),
    /** Sauce bottle fill level 0..255. */
    level: t.uint8().default(0),
    /** Layer index within its stack (0 = root). */
    layer: t.uint8().default(0),
    /** Root id of the stack this item belongs to ("" when it is a root itself). */
    root: t.string().default(""),
    /** Sauces applied to this layer (SAUCE_BIT flags). */
    sauceMask: t.uint8().default(0),
    /** Cups: drink code (data/drinks.ts drinkCode; 0 empty). The fill is in `level`. */
    drink: t.uint8().default(0),
  },
  "ItemState",
);
export type ItemState = SchemaType<typeof ItemState>;

export const GrillZoneState = schema(
  {
    knob: t.float32().default(0),
    /** Surface temperature in °C (fictional), 0..255. */
    temp: t.uint8().default(0),
  },
  "GrillZoneState",
);
export type GrillZoneState = SchemaType<typeof GrillZoneState>;

export const OrderState = schema(
  {
    number: t.uint16().default(0),
    recipe: t.string().default(""),
    modifiers: t.array("string"),
    /** Shift time (seconds) when the ticket printed. */
    createdAt: t.float32().default(0),
    /** "open" | "served" | "refused" | "cancelled" */
    status: t.string().default(""),
    score: t.uint8().default(0),
    /** Name of the customer who ordered ("" for tickets without a walk-in customer). */
    customer: t.string().default(""),
    /** Drink served with the burger (DrinkId), or "". */
    drink: t.string().default(""),
    /** Side served with the burger ("fries"), or "". */
    side: t.string().default(""),
  },
  "OrderState",
);
export type OrderState = SchemaType<typeof OrderState>;

/**
 * A walk-in customer. Only phase changes are replicated: both sides rebuild the walk from
 * data/customers.ts and evaluate it at the current tick (simulation/customers.ts).
 */
export const CustomerState = schema(
  {
    /** Look and name seed. */
    seed: t.uint16().default(0),
    /** Index into COUNTER_SPOTS. */
    spot: t.uint8().default(0),
    /** "arriving" | "ordering" (at the counter, waiting to be rung up) | "waiting" | "collecting" | "leaving" */
    phase: t.string().default(""),
    /** Server tick at which the phase started. */
    phaseAt: t.uint32().default(0),
    /** Key of their order in RestaurantState.orders once they have ordered. */
    order: t.string().default(""),
    /** Left without their food. */
    angry: t.boolean().default(false),
    /** What they say at the counter while "ordering". */
    say: t.string().default(""),
  },
  "CustomerState",
);
export type CustomerState = SchemaType<typeof CustomerState>;

export const RestaurantState = schema(
  {
    protocol: t.uint16().default(0),
    name: t.string().default(""),
    /** "prep" | "open" | "closing" | "summary" */
    phase: t.string().default(""),
    /** "relaxed" | "normal" */
    mode: t.string().default(""),
    paused: t.boolean().default(false),
    pauseReason: t.string().default(""),
    /** Server tick at which a resume countdown finishes, 0 when none. */
    resumeTick: t.uint32().default(0),
    /** Authoritative fixed-step counter (60 Hz). Drives client interpolation clocks. */
    tick: t.uint32().default(0),
    /** Simulated seconds since the shift opened. */
    shiftTime: t.float32().default(0),
    balance: t.int32().default(0),
    revenue: t.int32().default(0),
    costs: t.int32().default(0),
    waste: t.int32().default(0),
    served: t.uint16().default(0),
    nextOrder: t.uint16().default(0),
    /** "ok" | "pending" | "unavailable" */
    saveStatus: t.string().default(""),
    drawer: t.float32().default(0),
    shiftSwitch: t.boolean().default(false),
    players: t.map(PlayerState),
    items: t.map(ItemState),
    grill: t.array(GrillZoneState),
    orders: t.map(OrderState),
    stock: t.map("uint16"),
    /** Session ids voting for a co-op pause. */
    pauseVotes: t.array("string"),
    customers: t.map(CustomerState),
    /** The starting tutorial is running (one easy burger and a cola, then the normal shift). */
    tutorial: t.boolean().default(false),
  },
  "RestaurantState",
);
export type RestaurantState = SchemaType<typeof RestaurantState>;
