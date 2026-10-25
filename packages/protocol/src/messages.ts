import { z } from "zod";
import { INTERACTION, MAX_PACKS_PER_ORDER, NET, STOCK_KEYS, type StockKey } from "@ahb/data";

/**
 * Client → server intents. TypeScript types do not validate untrusted network input, so every
 * message is checked with these runtime schemas at the server boundary (spec §3, §14).
 */
export const PROTOCOL_VERSION = 4;

export const MSG = {
  input: "input",
  grab: "grab",
  place: "place",
  drop: "drop",
  setDown: "setDown",
  offer: "offer",
  knob: "knob",
  drawer: "drawer",
  spatula: "spatula",
  squeeze: "squeeze",
  shift: "shift",
  pause: "pause",
  ping: "ping",
  away: "away",
  tutorial: "tutorial",
  buy: "buy",
} as const;

export const SERVER_MSG = {
  welcome: "welcome",
  result: "result",
  toast: "toast",
  served: "served",
  ping: "ping",
  summary: "summary",
} as const;

const finite = (min: number, max: number) => z.number().min(min).max(max);
const id = z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/);
/** Client-generated, per-session increasing command id used for deduplication. */
const cmd = z.number().int().min(1).max(0xffffffff);
const point = z.object({ x: finite(-50, 50), y: finite(-10, 10), z: finite(-50, 50) });
/**
 * An angle in radians. Camera yaw accumulates as the player turns, so any finite value is
 * accepted (the server wraps it); a narrow range here rejected every place after a few turns.
 */
const angle = finite(-1e4, 1e4);

export const moveSampleSchema = z.object({
  seq: z.number().int().min(0).max(0xffffffff),
  mx: finite(-1, 1),
  mz: finite(-1, 1),
  yaw: angle,
  pitch: finite(-1.6, 1.6),
  buttons: z.number().int().min(0).max(255),
});

export const inputSchema = z.object({
  samples: z.array(moveSampleSchema).min(1).max(NET.maxSamplesPerMessage),
  /** Desired hold distance for the held item. */
  hold: finite(INTERACTION.holdDistanceMin, INTERACTION.holdDistanceMax).optional(),
  /** Held-object rotation offsets (radians) chosen with the rotate control. */
  rotYaw: angle.optional(),
  rotPitch: finite(-Math.PI, Math.PI).optional(),
});

export const grabSchema = z.union([
  z.object({ cmd, item: id, rev: z.number().int().min(0) }),
  z.object({ cmd, dispenser: id }),
]);

export const placeSchema = z.object({
  cmd,
  /** World point the player is placing at (from the client's raycast). */
  point,
  /** Item whose stack should receive the held item, if placing onto food or a tray. */
  onto: id.optional(),
  yaw: angle.optional(),
});

export const cmdOnlySchema = z.object({ cmd });

export const offerSchema = z.object({ cmd, to: z.string().min(1).max(64) });

export const knobSchema = z.object({ zone: z.number().int().min(0).max(7), value: finite(0, 1) });

export const drawerSchema = z.object({ value: finite(0, 1) });

export const spatulaSchema = z.object({
  cmd,
  /** slide: lift the targeted item onto the blade; flip: turn the carried item back onto the grill; assistFlip: both at once. */
  action: z.enum(["slide", "flip", "assistFlip"]),
  item: id.optional(),
  rev: z.number().int().min(0).optional(),
});

export const squeezeSchema = z.object({ target: id, intensity: finite(0, 1) });

export const shiftSchema = z.object({ cmd, action: z.enum(["open", "close"]) });

export const pauseSchema = z.object({ cmd, action: z.enum(["request", "resume", "cancel"]) });

export const buySchema = z.object({
  cmd,
  stock: z.enum(STOCK_KEYS as unknown as [StockKey, ...StockKey[]]),
  packs: z.number().int().min(1).max(MAX_PACKS_PER_ORDER),
});

export const tutorialSchema = z.object({ cmd, action: z.enum(["start", "skip"]) });

export const PING_PRESETS = ["need_patties", "need_buns", "on_grill", "order_up", "help", "thanks"] as const;
export const pingSchema = z.object({ cmd, preset: z.enum(PING_PRESETS), point: point.optional() });

export const awaySchema = z.object({ away: z.boolean() });

export const joinOptionsSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  name: z.string().trim().min(1).max(20),
  platform: z.enum(["desktop", "touch"]),
  /** Only used when creating a room: which owned restaurant to open. */
  restaurantId: z.string().uuid().optional(),
  mode: z.enum(["relaxed", "normal"]).optional(),
});

export type InputMessage = z.infer<typeof inputSchema>;
export type GrabMessage = z.infer<typeof grabSchema>;
export type PlaceMessage = z.infer<typeof placeSchema>;
export type SpatulaMessage = z.infer<typeof spatulaSchema>;
export type JoinOptions = z.infer<typeof joinOptionsSchema>;
export type PingPreset = (typeof PING_PRESETS)[number];

export interface WelcomeMessage {
  sessionId: string;
  protocol: number;
  restaurantId: string;
  code: string;
  isOwner: boolean;
  tickHz: number;
}

export interface ResultMessage {
  cmd: number;
  ok: boolean;
  reason?: string;
}

export interface ToastMessage {
  text: string;
  tone: "info" | "warn" | "success";
}

export interface ServedMessage {
  orderNumber: number;
  score: number;
  feedback: string[];
  priceCents: number;
  tipCents: number;
  accepted: boolean;
  by: string;
}

export interface PingMessage {
  from: string;
  name: string;
  preset: PingPreset;
  point?: { x: number; y: number; z: number };
}

export interface SummaryMessage {
  revenue: number;
  costs: number;
  waste: number;
  served: number;
  refused: number;
  profit: number;
  balance: number;
}

export const PING_TEXT: Record<PingPreset, string> = {
  need_patties: "Need patties!",
  need_buns: "Need buns!",
  on_grill: "I'm on the grill",
  order_up: "Order up!",
  help: "Help here!",
  thanks: "Thanks!",
};
