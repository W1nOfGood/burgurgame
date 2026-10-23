/**
 * Engineering targets from spec §14/§16. These are starting values to profile and tune,
 * not measured guarantees.
 */
export const NET = {
  /** Authoritative fixed simulation rate. */
  tickHz: 60,
  /** State patch rate (Colyseus patchRate = 1000 / patchHz). */
  patchHz: 20,
  /** Client input message rate; each message carries several fixed-step samples. */
  inputSendHz: 30,
  /** Upper bound on samples a single input message may carry. */
  maxSamplesPerMessage: 6,
  /**
   * Movement samples buffered per player on the server (2 s). Every sample a client simulated
   * must also run on the server, or its prediction disagrees and the player is pulled back; on
   * long routes input arrives in bursts after stalls, so the queue must absorb them. Only a
   * client that sends more than real time can fill it.
   */
  maxQueuedSamples: 120,
  /** Samples the server may run for one player in one tick while catching up on a burst. */
  maxCatchUpSamplesPerTick: 4,
  /** Smallest remote interpolation delay; it grows with measured arrival jitter. */
  interpolationDelayMs: 100,
  /** Largest remote interpolation delay. */
  maxInterpolationDelayMs: 500,
  /** How far past the newest snapshot remote motion may be extrapolated when data runs late. */
  maxExtrapolationMs: 100,
  /** Reconnect grace period for dropped connections. */
  reconnectGraceSeconds: 60,
  /** Maximum fixed steps the server will run to catch up after a stall. */
  maxCatchUpSteps: 4,
  /** Rate limit for discrete (non-input) intent messages per client per second. */
  maxIntentsPerSecond: 40,
} as const;

export const ROOM = {
  maxPlayers: 4,
  codeLength: 6,
  /** Unambiguous upper-case alphabet for room codes (no 0/O/1/I/L). */
  codeAlphabet: "ABCDEFGHJKMNPQRSTUVWXYZ23456789",
  maxActiveItems: 80,
  checkpointIntervalMs: 15_000,
  leaseTtlMs: 45_000,
  /** Seconds of countdown when a paused room resumes. */
  resumeCountdownSeconds: 3,
} as const;

export const PLAYER = {
  radius: 0.3,
  /** Half height of the capsule's cylindrical segment. Total height = 2 * (halfHeight + radius). */
  halfHeight: 0.55,
  eyeHeight: 1.62,
  crouchEyeHeight: 1.15,
  walkSpeed: 2.4,
  sprintSpeed: 3.6,
  crouchSpeed: 1.3,
  /** Carrying a tray slows you down a little so co-op hand-offs have value. */
  carrySpeedFactor: 0.9,
  acceleration: 18,
  gravity: -20,
  maxPitch: 1.45,
  controllerOffset: 0.02,
  snapToGround: 0.2,
  autostepHeight: 0.25,
} as const;

export const INTERACTION = {
  /** Default interaction reach from the eye, metres (spec §6). */
  reach: 1.8,
  /** Server allowance on top of reach to absorb latency and interpolation. */
  reachTolerance: 0.3,
  holdDistanceMin: 0.35,
  holdDistanceMax: 1.2,
  holdDistanceDefault: 0.6,
  /** Hold distance used when offering an item to a teammate. */
  offerDistance: 1.0,
  /** Max player-to-player distance for a hand-over. */
  handoverRange: 2.4,
  /** Snap radius for placement assistance. */
  placementSnap: 0.12,
  /** Vertical tolerance when validating that a point lies on a surface. */
  surfaceTolerance: 0.06,
  /** Maximum logical layers in one stack (tray + burger). */
  maxStackLayers: 12,
  /** Seconds an assisted spatula flip takes on the server. */
  flipDuration: 0.45,
  /** Knob angular rate limit in full-range per second. */
  knobMaxRate: 3,
  /** Drawer travel rate limit in full-range per second. */
  drawerMaxRate: 4,
  /** Sauce flow at full squeeze, in sauce units per second. */
  sauceFlowRate: 0.6,
} as const;

/**
 * Explicitly fictional, accelerated cooking curves (spec §8). Visual browning in this game is
 * not food-safety guidance.
 */
export const COOKING = {
  ambientTemp: 21,
  fridgeTemp: 4,
  /** Grill surface temperature at knob = 1. */
  grillMaxTemp: 250,
  /** How quickly a grill zone approaches its knob setting (1/s). */
  grillResponse: 0.5,
  /** Below this surface temperature nothing browns. */
  browningOnset: 110,
  /** Surface temperature span over which heat factor goes 0 → 1. */
  browningSpan: 120,
  /** Browning per second of the side in contact at heat factor 1. */
  sideRate: 0.026,
  /** Fraction of sideRate the upper side receives indirectly. */
  upperSideFraction: 0.05,
  /** Internal progress per second at heat factor 1. */
  innerRate: 0.0165,
  /** Moisture lost per second at heat factor 1. */
  moistureRate: 0.004,
  /** Burn accumulation per second per unit of browning above 1. */
  burnRate: 0.35,
  /** Item temperature target while on the grill, as a fraction of surface temperature rise. */
  contactTempFraction: 0.32,
  /** Temperature response while heated (1/s). */
  heatResponse: 0.25,
  /** Cooling response when removed from heat (1/s). */
  coolResponse: 0.012,
  /** Cheese starts softening above this temperature underneath it. */
  meltOnset: 45,
  meltSpan: 35,
  meltRate: 0.12,
  /** Bun toasting per second at heat factor 1. */
  toastRate: 0.06,
  /** Relative cook speed of other grill items versus a patty side. */
  rateFactor: { veggie_patty: 1.35, bacon: 1.7, egg: 1.5, mushroom: 1.4, onion: 1.2 } as Record<string, number>,
  /** Above this temperature food counts as warm when served. */
  warmServeTemp: 45,
} as const;

export const SHIFT = {
  /** Base seconds between orders for a single player in relaxed mode. */
  relaxedOrderInterval: 75,
  /** Base seconds between orders for a single player in a normal shift. */
  normalOrderInterval: 50,
  /** Each additional player shortens the interval by this factor. */
  perPlayerPressure: 0.45,
  maxOpenOrdersBase: 3,
  /** Normal shift length in seconds (spec: 15–25 min). */
  normalShiftSeconds: 18 * 60,
  /** Seconds an order may wait before patience penalties start. */
  patienceSeconds: 180,
  /** Shift seconds after which tier 2 / tier 3 recipes start appearing on tickets. */
  tier2After: { relaxed: 180, normal: 90 },
  tier3After: { relaxed: 420, normal: 240 },
  /** Chance a ticket carries a modifier. */
  modifierChance: 0.35,
} as const;
