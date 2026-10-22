import { randomUUID } from "node:crypto";
import {
  BOXES,
  CHILLER_DRAWER,
  COOKING,
  GRILL_ZONES,
  INITIAL_ITEMS,
  INTERACTION,
  ITEMS,
  NET,
  PLAYER,
  RECIPES,
  RECIPE_IDS,
  ROOM,
  SAUCE_BIT,
  SHIFT,
  SHIFT_SWITCH,
  SPAWN_POINTS,
  SPAWN_YAW,
  STOCK_KEYS,
  isPatty,
  modifiersFor,
  stockKeyFor,
  type ItemKind,
  type ModifierId,
  type RecipeId,
  type StockKey,
} from "@ahb/data";
import {
  BUTTON_CROUCH,
  ITEM_GROUPS,
  PlayerMotor,
  canAddToStack,
  createFoodState,
  createRng,
  dispenserById,
  distance,
  evaluateBurger,
  eyePosition,
  footprintRadius,
  grillZoneAt,
  hasLineOfSight,
  inPickupZone,
  inTrashZone,
  isNoPlaceArea,
  lookDirection,
  restingHeight,
  stackOffsets,
  stepFood,
  stepGrillTemp,
  surfaceAt,
  withinReach,
  type Evaluation,
  type FoodState,
  type MoveSample,
  type PhysicsWorld,
  type ServedLayer,
  type V3,
} from "@ahb/simulation";
import {
  GrillZoneState,
  ItemState,
  OrderState,
  PlayerState,
  writeFoodBytes,
  type InputMessage,
  type RestaurantState,
} from "@ahb/protocol";
import { IDENTITY, quatAxisX, quatMul, quatYaw, rotate, yawOf, type Quat } from "./quat.js";

export type IntentResult = { ok: true } | { ok: false; reason: string };
const OK: IntentResult = { ok: true };
const fail = (reason: string): IntentResult => ({ ok: false, reason });

export type Tone = "info" | "warn" | "success";

export interface ServeRequest {
  trayId: string;
  orderId: string;
  orderNumber: number;
  orderKey: string;
  shiftId: string;
  evaluation: Evaluation;
  servedItemIds: string[];
  by: string;
}

export interface ShiftSummary {
  shiftId: string;
  revenue: number;
  costs: number;
  waste: number;
  served: number;
  refused: number;
}

export interface KitchenHooks {
  toast(sessionId: string, text: string, tone?: Tone): void;
  broadcastToast(text: string, tone?: Tone): void;
  requestServe(req: ServeRequest): void;
  shiftEnded(summary: ShiftSummary): void;
}

export interface KitchenOptions {
  mode: "relaxed" | "normal";
  seed?: number;
  stock: Record<StockKey, number>;
  balanceCents: number;
  name: string;
}

type RigidBody = ReturnType<PhysicsWorld["world"]["createRigidBody"]>;

interface PlayerRt {
  id: string;
  s: PlayerState;
  motor: PlayerMotor;
  queue: MoveSample[];
  lastSeq: number;
  lastInputTick: number;
  credit: number;
  crouch: boolean;
  hold: number;
  rotYaw: number;
  rotPitch: number;
  joinedAt: number;
  lastKnobTick: number;
  lastDrawerTick: number;
  lastSqueezeTick: number;
}

interface ItemRt {
  id: string;
  kind: ItemKind;
  s: ItemState;
  food: FoodState | null;
  pos: V3;
  rot: Quat;
  body: RigidBody | null;
  parent: string | null;
  child: string | null;
  holder: string | null;
  /** Locked while a serve transaction is in flight. */
  locked: boolean;
  flip: { t: number; at: V3; yaw: number } | null;
  level: number;
  offeredTo: string | null;
  offeredUntil: number;
  zone: number;
  /** Stack signature at the last serve attempt, so a refused tray is not re-evaluated every tick. */
  serveSig: string;
}

interface OrderRt {
  id: string;
  s: OrderState;
  reservedBy: string | null;
}

export interface ItemSnapshot {
  id: string;
  kind: ItemKind;
  pos: [number, number, number];
  rot: [number, number, number, number];
  parent: string | null;
  food: FoodState | null;
  level: number;
}

export interface KitchenSnapshot {
  v: 1;
  itemSeq: number;
  phase: string;
  mode: "relaxed" | "normal";
  shiftId: string;
  shiftTime: number;
  nextOrderAt: number;
  revenue: number;
  costs: number;
  waste: number;
  served: number;
  refused: number;
  nextOrder: number;
  drawer: number;
  knobs: number[];
  grillTemps: number[];
  items: ItemSnapshot[];
  orders: { id: string; number: number; recipe: RecipeId; modifiers: ModifierId[]; createdAt: number; status: string; score: number }[];
}

const PLAYER_COLORS = 6;

export class Kitchen {
  readonly state: RestaurantState;
  private readonly pw: PhysicsWorld;
  private readonly hooks: KitchenHooks;
  private readonly players = new Map<string, PlayerRt>();
  private readonly items = new Map<string, ItemRt>();
  private readonly orders = new Map<string, OrderRt>();
  private readonly grillTemps: number[] = GRILL_ZONES.map(() => COOKING.ambientTemp);
  private rng: () => number;
  private itemSeq = 0;
  private joinSeq = 0;
  private refused = 0;
  shiftId = "";
  private nextOrderAt = 0;
  private resumeAtTick = 0;

  constructor(pw: PhysicsWorld, state: RestaurantState, hooks: KitchenHooks, opts: KitchenOptions) {
    this.pw = pw;
    this.state = state;
    this.hooks = hooks;
    this.rng = createRng(opts.seed ?? Date.now());
    state.name = opts.name;
    state.mode = opts.mode;
    state.phase = "prep";
    state.balance = opts.balanceCents;
    state.saveStatus = "ok";
    state.nextOrder = 1;
    for (const zone of GRILL_ZONES) {
      const g = new GrillZoneState();
      g.knob = 0;
      g.temp = Math.round(COOKING.ambientTemp);
      state.grill.push(g);
      void zone;
    }
    for (const key of STOCK_KEYS) state.stock.set(key, opts.stock[key] ?? 0);
    for (const init of INITIAL_ITEMS) {
      const it = this.createItem(init.kind, { x: init.position[0], y: init.position[1], z: init.position[2] }, quatYaw(init.yaw ?? 0));
      this.ensureBody(it);
    }
    this.syncAll();
  }

  // ---------------------------------------------------------------------------------------
  // Players

  addPlayer(sessionId: string, info: { name: string; platform: "desktop" | "touch" }): PlayerState {
    const spawn = this.pickSpawn();
    const s = new PlayerState();
    s.name = info.name;
    s.platform = info.platform;
    s.color = this.joinSeq % PLAYER_COLORS;
    s.x = spawn.x;
    s.y = spawn.y;
    s.z = spawn.z;
    s.yaw = SPAWN_YAW;
    s.connected = true;
    s.hold = INTERACTION.holdDistanceDefault;
    const motor = new PlayerMotor(this.pw, spawn);
    const rt: PlayerRt = {
      id: sessionId,
      s,
      motor,
      queue: [],
      lastSeq: 0,
      lastInputTick: this.state.tick,
      credit: 8,
      crouch: false,
      hold: INTERACTION.holdDistanceDefault,
      rotYaw: 0,
      rotPitch: 0,
      joinedAt: this.joinSeq++,
      lastKnobTick: 0,
      lastDrawerTick: 0,
      lastSqueezeTick: 0,
    };
    this.players.set(sessionId, rt);
    this.state.players.set(sessionId, s);
    if (![...this.players.values()].some((p) => p.s.admin && p.id !== sessionId)) s.admin = true;
    return s;
  }

  removePlayer(sessionId: string): void {
    const p = this.players.get(sessionId);
    if (!p) return;
    this.safelyRelease(p);
    p.motor.dispose();
    this.players.delete(sessionId);
    this.state.players.delete(sessionId);
    const votes = this.state.pauseVotes.indexOf(sessionId);
    if (votes >= 0) this.state.pauseVotes.splice(votes, 1);
    if (p.s.admin) this.transferAdmin();
  }

  /** Admin passes to the longest-connected remaining player; restaurant ownership never moves. */
  private transferAdmin(): void {
    const next = [...this.players.values()].filter((p) => p.s.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    for (const p of this.players.values()) p.s.admin = p === next;
  }

  setConnected(sessionId: string, connected: boolean): void {
    const p = this.players.get(sessionId);
    if (!p) return;
    p.s.connected = connected;
    // Safe input clearing (spec §6A/§13): no movement or manipulation continues while away.
    p.queue.length = 0;
    if (!connected) {
      this.safelyRelease(p);
      if (p.s.admin) {
        p.s.admin = false;
        this.transferAdmin();
        if (![...this.players.values()].some((q) => q.s.admin)) p.s.admin = true;
      }
    }
  }

  connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.s.connected) n++;
    return n;
  }

  hasPlayer(sessionId: string): boolean {
    return this.players.has(sessionId);
  }

  isAdmin(sessionId: string): boolean {
    return this.players.get(sessionId)?.s.admin ?? false;
  }

  private pickSpawn(): V3 {
    for (const sp of SPAWN_POINTS) {
      const p = { x: sp[0], y: sp[1], z: sp[2] };
      if (![...this.players.values()].some((q) => Math.hypot(q.motor.state.x - p.x, q.motor.state.z - p.z) < 0.7)) return p;
    }
    const sp = SPAWN_POINTS[0]!;
    return { x: sp[0], y: sp[1], z: sp[2] };
  }

  pushInput(sessionId: string, msg: InputMessage): void {
    const p = this.players.get(sessionId);
    if (!p || !p.s.connected) return;
    for (const sample of msg.samples) {
      if (sample.seq <= p.lastSeq) continue; // replayed or duplicated sample
      p.lastSeq = sample.seq;
      p.queue.push({ ...sample, pitch: Math.max(-PLAYER.maxPitch, Math.min(PLAYER.maxPitch, sample.pitch)) });
    }
    // Bounded queue: discard the oldest motion rather than building a backlog.
    if (p.queue.length > NET.maxQueuedSamples) p.queue.splice(0, p.queue.length - NET.maxQueuedSamples);
    if (msg.hold !== undefined) p.hold = msg.hold;
    if (msg.rotYaw !== undefined) p.rotYaw = msg.rotYaw;
    if (msg.rotPitch !== undefined) p.rotPitch = msg.rotPitch;
    p.lastInputTick = this.state.tick;
  }

  setAway(sessionId: string, away: boolean): void {
    const p = this.players.get(sessionId);
    if (!p) return;
    p.s.away = away;
    if (away) p.queue.length = 0;
  }

  // ---------------------------------------------------------------------------------------
  // Items

  private createItem(kind: ItemKind, pos: V3, rot: Quat = IDENTITY, id?: string): ItemRt {
    const itemId = id ?? `i${++this.itemSeq}`;
    const s = new ItemState();
    s.kind = kind;
    const def = ITEMS[kind];
    const it: ItemRt = {
      id: itemId,
      kind,
      s,
      food: def.food ? createFoodState(kind) : null,
      pos: { ...pos },
      rot: { ...rot },
      body: null,
      parent: null,
      child: null,
      holder: null,
      locked: false,
      flip: null,
      level: kind === "sauce_bottle" ? 1 : 0,
      offeredTo: null,
      offeredUntil: 0,
      zone: -1,
      serveSig: "",
    };
    s.level = Math.round(it.level * 255);
    this.items.set(itemId, it);
    this.state.items.set(itemId, s);
    return it;
  }

  activeItemCount(): number {
    return this.items.size;
  }

  private ensureBody(it: ItemRt): void {
    if (it.body || it.parent || it.holder || it.flip || it.locked) return;
    const { R, world } = this.pw;
    const def = ITEMS[it.kind];
    const body = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(it.pos.x, it.pos.y, it.pos.z)
        .setRotation(it.rot)
        .setLinearDamping(0.4)
        .setAngularDamping(1.5)
        .setCcdEnabled(true),
    );
    const shape = def.shape;
    const cd = shape.type === "cylinder" ? R.ColliderDesc.cylinder(shape.halfHeight, shape.radius) : R.ColliderDesc.cuboid(shape.half[0], shape.half[1], shape.half[2]);
    cd.setCollisionGroups(ITEM_GROUPS).setFriction(0.9).setRestitution(0.02).setMass(def.mass);
    world.createCollider(cd, body);
    it.body = body;
  }

  private removeBody(it: ItemRt): void {
    if (!it.body) return;
    this.pw.world.removeRigidBody(it.body);
    it.body = null;
  }

  private rootOf(it: ItemRt): ItemRt {
    let cur = it;
    for (let i = 0; i < 32 && cur.parent; i++) cur = this.items.get(cur.parent)!;
    return cur;
  }

  private topOf(it: ItemRt): ItemRt {
    let cur = it;
    for (let i = 0; i < 32 && cur.child; i++) cur = this.items.get(cur.child)!;
    return cur;
  }

  private stackFrom(root: ItemRt): ItemRt[] {
    const out = [root];
    let cur = root;
    for (let i = 0; i < 32 && cur.child; i++) {
      cur = this.items.get(cur.child)!;
      out.push(cur);
    }
    return out;
  }

  private bump(it: ItemRt): void {
    it.s.rev = (it.s.rev + 1) >>> 0;
  }

  private destroyStack(root: ItemRt, asWaste: boolean): string[] {
    const ids: string[] = [];
    for (const it of this.stackFrom(root)) {
      if (asWaste && it.food) this.state.waste += ITEMS[it.kind].costCents;
      this.removeBody(it);
      this.items.delete(it.id);
      this.state.items.delete(it.id);
      ids.push(it.id);
      for (const p of this.players.values()) if (p.s.held === it.id) p.s.held = "";
    }
    if (root.parent) {
      const parent = this.items.get(root.parent);
      if (parent) parent.child = null;
    }
    return ids;
  }

  private detach(it: ItemRt): void {
    if (!it.parent) return;
    const parent = this.items.get(it.parent);
    if (parent) {
      parent.child = null;
      this.bump(parent);
    }
    it.parent = null;
  }

  private attach(base: ItemRt, it: ItemRt): void {
    const top = this.topOf(base);
    top.child = it.id;
    it.parent = top.id;
    this.removeBody(it);
    this.bump(top);
    this.bump(it);
  }

  private player(sessionId: string): PlayerRt | null {
    const p = this.players.get(sessionId);
    return p && p.s.connected ? p : null;
  }

  private eye(p: PlayerRt): V3 {
    return eyePosition(p.motor.state, p.crouch);
  }

  private canReach(p: PlayerRt, point: V3, extra = 0): IntentResult {
    const eye = this.eye(p);
    if (!withinReach(eye, point, extra)) return fail("That's out of reach");
    if (!hasLineOfSight(this.pw.castStatic, eye, point)) return fail("Something is in the way");
    return OK;
  }

  private heldItem(p: PlayerRt): ItemRt | null {
    return p.s.held ? (this.items.get(p.s.held) ?? null) : null;
  }

  private takeHold(p: PlayerRt, it: ItemRt): void {
    this.removeBody(it);
    it.holder = p.id;
    it.s.holder = p.id;
    it.offeredTo = null;
    it.s.offered = false;
    it.zone = -1;
    p.s.held = it.id;
    p.hold = Math.max(p.hold, INTERACTION.holdDistanceDefault);
    p.rotYaw = 0;
    p.rotPitch = 0;
    this.bump(it);
  }

  private releaseHold(p: PlayerRt, it: ItemRt): void {
    it.holder = null;
    it.s.holder = "";
    it.offeredTo = null;
    it.s.offered = false;
    p.s.held = "";
    this.bump(it);
  }

  // ---------------------------------------------------------------------------------------
  // Intents. Each validates identity, reach, line of sight, ownership, revision and the allowed
  // transition before mutating anything. Room messages are processed serially, so the first
  // valid grab of an item wins and later ones see the bumped revision.

  grabItem(sessionId: string, itemId: string, rev: number): IntentResult {
    const p = this.player(sessionId);
    if (!p) return fail("Not connected");
    if (this.state.paused) return fail("The room is paused");
    if (p.s.held) return fail("Your hands are full");
    const target = this.items.get(itemId);
    if (!target) return fail("That's gone");
    if (target.s.rev !== rev) return fail("Someone else got there first");
    if (target.locked) return fail("That order is being handed over");
    if (target.flip) return fail("It's mid-flip");

    // Hand-over: take an item a teammate is offering.
    const tRoot = this.rootOf(target);
    if (tRoot.holder && tRoot.holder !== sessionId) {
      if (tRoot.offeredTo === null || tRoot !== target) return fail("Your teammate is holding that");
      const giver = this.players.get(tRoot.holder);
      if (giver && distance(giver.motor.state, p.motor.state) > INTERACTION.handoverRange + INTERACTION.reachTolerance) return fail("Move closer to take it");
      const reach = this.canReach(p, tRoot.pos);
      if (!reach.ok) return reach;
      if (giver) this.releaseHold(giver, tRoot);
      this.takeHold(p, tRoot);
      if (giver) this.hooks.toast(giver.id, `${p.s.name} took the ${ITEMS[tRoot.kind].label.toLowerCase()}`, "info");
      return OK;
    }

    const reach = this.canReach(p, { x: target.pos.x, y: target.pos.y + 0.02, z: target.pos.z });
    if (!reach.ok) return reach;

    // Picking the top layer lifts just that layer; any lower layer lifts the whole stack.
    let picked: ItemRt;
    if (target.parent && !target.child) {
      const parent = this.items.get(target.parent)!;
      if (parent.kind === "spatula" && parent.holder && parent.holder !== sessionId) return fail("Your teammate is holding that");
      this.detach(target);
      picked = target;
    } else {
      picked = tRoot;
    }
    if (picked.holder) return fail("Someone is holding that");
    this.takeHold(p, picked);
    return OK;
  }

  grabFromDispenser(sessionId: string, dispenserId: string): IntentResult {
    const p = this.player(sessionId);
    if (!p) return fail("Not connected");
    if (this.state.paused) return fail("The room is paused");
    if (p.s.held) return fail("Your hands are full");
    const d = dispenserById(dispenserId);
    if (!d) return fail("Nothing there");
    let center: V3 = { x: d.center[0], y: d.center[1], z: d.center[2] };
    if (d.requiresDrawer !== undefined) {
      if (this.state.drawer < d.requiresDrawer) return fail("Open the chiller drawer first");
      // Patties sit in the part of the tub that slides out in front of the counter.
      center = { x: center.x, y: center.y, z: CHILLER_DRAWER.handle[2] - this.state.drawer * CHILLER_DRAWER.travel + 0.15 };
    }
    const reach = this.canReach(p, center, 0.2);
    if (!reach.ok) return reach;
    if (this.items.size >= ROOM.maxActiveItems) return fail("Too much clutter — clear some items first");
    if (d.kind === "tray" && [...this.items.values()].filter((i) => i.kind === "tray").length >= 6) return fail("Use one of the trays already out");
    const key = stockKeyFor(d.kind);
    if (key) {
      const left = this.state.stock.get(key) ?? 0;
      if (left <= 0) return fail(`Out of ${ITEMS[d.kind].label.toLowerCase()} — restock in the office`);
      this.state.stock.set(key, left - 1);
      this.state.costs += ITEMS[d.kind].costCents;
    }
    const it = this.createItem(d.kind, center, quatYaw(p.s.yaw));
    this.takeHold(p, it);
    return OK;
  }

  /** Releases the held item onto a surface point or onto another item's stack. */
  place(sessionId: string, point: V3, ontoId: string | undefined, yaw: number | undefined): IntentResult {
    const p = this.player(sessionId);
    if (!p) return fail("Not connected");
    if (this.state.paused) return fail("The room is paused");
    const held = this.heldItem(p);
    if (!held) return fail("You're not holding anything");
    // A spatula places its load and stays in hand.
    const moving = held.kind === "spatula" && held.child ? this.items.get(held.child)! : held;
    const reach = this.canReach(p, { x: point.x, y: point.y + 0.03, z: point.z });
    if (!reach.ok) return reach;

    if (ontoId) {
      const target = this.items.get(ontoId);
      if (!target) return fail("That's gone");
      const tRoot = this.rootOf(target);
      if (tRoot === held || this.rootOf(moving) === tRoot) return fail("Can't stack something on itself");
      if (tRoot.holder || tRoot.locked || tRoot.flip) return fail("That's busy");
      if (distance(target.pos, point) > 0.35) return fail("Aim at the stack you're adding to");
      return this.stackOnto(p, held, moving, tRoot);
    }

    if (inTrashZone(point)) return this.trash(p, held, moving);

    const surf = surfaceAt(point);
    if (!surf || isNoPlaceArea(point)) return fail("Can't put that there");
    if (surf.kind === "floor" && ITEMS[moving.kind].food) return fail("Not on the floor!");
    const spot = this.resolveSpot(moving, { x: point.x, y: surf.y, z: point.z }, surf.kind === "grill");
    if (spot.stackOn) return this.stackOnto(p, held, moving, spot.stackOn);
    if (!spot.pos) return fail("No room there");
    this.putDown(p, held, moving, spot.pos, quatYaw(yaw ?? p.s.yaw));
    return OK;
  }

  private stackOnto(p: PlayerRt, held: ItemRt, moving: ItemRt, base: ItemRt): IntentResult {
    const kinds = this.stackFrom(base).map((i) => i.kind);
    const movingKinds = this.stackFrom(moving).map((i) => i.kind);
    if (kinds.length + movingKinds.length > INTERACTION.maxStackLayers) return fail("That stack is too tall");
    const check = canAddToStack(kinds, moving.kind);
    if (!check.ok) return fail(check.reason);
    if (moving === held) this.releaseHold(p, held);
    else this.detach(moving);
    this.attach(base, moving);
    this.layoutStack(base);
    this.checkPickup(base, p.id);
    return OK;
  }

  private putDown(p: PlayerRt, held: ItemRt, moving: ItemRt, pos: V3, rot: Quat): void {
    if (moving === held) this.releaseHold(p, held);
    else this.detach(moving);
    moving.pos = { ...pos };
    moving.rot = rot;
    this.ensureBody(moving);
    moving.body?.sleep();
    this.bump(moving);
    this.layoutStack(moving);
    this.checkPickup(moving, p.id);
  }

  private trash(p: PlayerRt, held: ItemRt, moving: ItemRt): IntentResult {
    if (!ITEMS[moving.kind].food && moving.kind !== "tray") return fail("Don't throw the tools away!");
    if (moving.kind === "tray") {
      // Trays are reusable: scrape the food into the bin and keep the tray in hand.
      if (!moving.child) return fail("The tray is already empty");
      this.destroyStack(this.items.get(moving.child)!, true);
      this.bump(moving);
      this.hooks.toast(p.id, "Scraped the tray into the bin", "info");
      return OK;
    }
    if (moving === held) this.releaseHold(p, held);
    else this.detach(moving);
    this.destroyStack(moving, true);
    return OK;
  }

  /** Placement assistance: snaps into grill zones, nudges away from neighbours, or stacks. */
  private resolveSpot(moving: ItemRt, point: V3, grill: boolean): { pos?: V3; stackOn?: ItemRt } {
    const r = footprintRadius(moving.kind);
    let x = point.x;
    let z = point.z;
    if (grill) {
      let best = GRILL_ZONES[0]!;
      let bestD = Infinity;
      for (const zone of GRILL_ZONES) {
        const cx = Math.max(zone.rect.minX, Math.min(zone.rect.maxX, x));
        const cz = Math.max(zone.rect.minZ, Math.min(zone.rect.maxZ, z));
        const d = Math.hypot(cx - x, cz - z);
        if (d < bestD) {
          bestD = d;
          best = zone;
        }
      }
      const m = Math.min(r * 0.6, 0.08);
      x = Math.max(best.rect.minX + m, Math.min(best.rect.maxX - m, x));
      z = Math.max(best.rect.minZ + m, Math.min(best.rect.maxZ - m, z));
    }
    const y = point.y + restingHeight(moving.kind) + 0.002;
    for (let attempt = 0; attempt < 3; attempt++) {
      const blocker = this.overlapping(moving, x, y, z, r);
      if (!blocker) return { pos: { x, y, z } };
      const top = this.topOf(blocker);
      if (attempt === 0 && Math.hypot(blocker.pos.x - x, blocker.pos.z - z) < INTERACTION.placementSnap && canAddToStack(this.stackFrom(blocker).map((i) => i.kind), moving.kind).ok) {
        void top;
        return { stackOn: blocker };
      }
      // Nudge directly away from the blocker to the minimum separation.
      const dx = x - blocker.pos.x;
      const dz = z - blocker.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const need = r + footprintRadius(blocker.kind) + 0.005;
      x = blocker.pos.x + (dx / len) * need;
      z = blocker.pos.z + (dz / len) * need;
      if (!surfaceAt({ x, y: point.y, z }) || isNoPlaceArea({ x, y: point.y, z })) return {};
    }
    return {};
  }

  private overlapping(self: ItemRt, x: number, y: number, z: number, r: number): ItemRt | null {
    for (const other of this.items.values()) {
      if (other === self || other.parent || other.holder || this.rootOf(self) === other) continue;
      if (Math.abs(other.pos.y - y) > 0.12) continue;
      const need = r + footprintRadius(other.kind) - 0.01;
      if (Math.hypot(other.pos.x - x, other.pos.z - z) < need) return other;
    }
    return null;
  }

  /** Lets go of the held item in mid-air; it falls under physics. */
  drop(sessionId: string): IntentResult {
    const p = this.player(sessionId);
    if (!p) return fail("Not connected");
    const held = this.heldItem(p);
    if (!held) return fail("You're not holding anything");
    this.releaseHold(p, held);
    this.ensureBody(held);
    held.body?.setLinvel({ x: p.motor.state.vx * 0.8, y: 0.3, z: p.motor.state.vz * 0.8 }, true);
    return OK;
  }

  /** Q / safe set-down: finds a valid nearby surface so nothing is lost or contaminated. */
  setDown(sessionId: string): IntentResult {
    const p = this.player(sessionId);
    if (!p) return fail("Not connected");
    if (this.state.paused) return fail("The room is paused");
    const held = this.heldItem(p);
    if (!held) return fail("You're not holding anything");
    const moving = held.kind === "spatula" && held.child ? this.items.get(held.child)! : held;
    const spot = this.findRestSpot(moving, this.eye(p), lookDirection(p.s.yaw, p.s.pitch), p);
    if (!spot) return fail("No free surface in reach");
    if (spot.stackOn) return this.stackOnto(p, held, moving, spot.stackOn);
    this.putDown(p, held, moving, spot.pos!, quatYaw(p.s.yaw));
    return OK;
  }

  private findRestSpot(moving: ItemRt, eye: V3, dir: V3, p: PlayerRt | null): { pos?: V3; stackOn?: ItemRt } | null {
    const food = ITEMS[moving.kind].food;
    // First choice: where the player is looking.
    const hit = this.pw.castStatic(eye, dir, INTERACTION.reach);
    if (hit !== null) {
      const pt = { x: eye.x + dir.x * hit, y: eye.y + dir.y * hit, z: eye.z + dir.z * hit };
      const surf = surfaceAt(pt, 0.03);
      if (surf && !isNoPlaceArea(pt) && !(food && surf.kind === "floor") && !inPickupZone(pt)) {
        const spot = this.resolveSpot(moving, { x: pt.x, y: surf.y, z: pt.z }, surf.kind === "grill");
        if (spot.pos || spot.stackOn) return spot;
      }
    }
    // Otherwise the closest free counter spot in reach.
    const candidates: { pos: V3; d: number }[] = [];
    for (const box of BOXES) {
      if (!box.surface || box.surface === "grill" || (box.surface === "floor" && food)) continue;
      const top = box.center[1] + box.half[1];
      const m = 0.08;
      for (const fx of [-0.8, -0.4, 0, 0.4, 0.8]) {
        for (const fz of [-0.6, 0, 0.6]) {
          let x = box.center[0] + fx * (box.half[0] - m);
          let z = box.center[2] + fz * (box.half[2] - m);
          if (box.surface === "floor") {
            x = eye.x + dir.x * 0.6 + fx * 0.3;
            z = eye.z + dir.z * 0.6 + fz * 0.3;
          }
          const pt = { x, y: top, z };
          if (isNoPlaceArea(pt) || inPickupZone(pt)) continue;
          const d = distance(eye, pt);
          if (d > INTERACTION.reach) continue;
          candidates.push({ pos: pt, d });
        }
      }
    }
    candidates.sort((a, b) => a.d - b.d);
    for (const c of candidates) {
      if (p && !hasLineOfSight(this.pw.castStatic, eye, { x: c.pos.x, y: c.pos.y + 0.03, z: c.pos.z })) continue;
      const spot = this.resolveSpot(moving, c.pos, false);
      if (spot.pos) return { pos: spot.pos };
    }
    return null;
  }

  offer(sessionId: string, to: string): IntentResult {
    const p = this.player(sessionId);
    if (!p) return fail("Not connected");
    const held = this.heldItem(p);
    if (!held) return fail("You're not holding anything");
    const other = this.player(to);
    if (!other || other === p) return fail("Nobody to hand that to");
    if (distance(other.motor.state, p.motor.state) > INTERACTION.handoverRange) return fail("Get closer to hand it over");
    held.offeredTo = to;
    held.offeredUntil = this.state.tick + 10 * 60;
    held.s.offered = true;
    p.hold = INTERACTION.offerDistance;
    this.hooks.toast(to, `${p.s.name} is handing you a ${ITEMS[held.kind].label.toLowerCase()}`, "info");
    return OK;
  }

  setKnob(sessionId: string, zone: number, value: number): IntentResult {
    const p = this.player(sessionId);
    if (!p) return fail("Not connected");
    const z = GRILL_ZONES[zone];
    const g = this.state.grill[zone];
    if (!z || !g) return fail("No such knob");
    const reach = this.canReach(p, { x: z.knob[0], y: z.knob[1], z: z.knob[2] });
    if (!reach.ok) return reach;
    const elapsed = Math.max(1, this.state.tick - p.lastKnobTick) / NET.tickHz;
    p.lastKnobTick = this.state.tick;
    const maxDelta = INTERACTION.knobMaxRate * Math.min(elapsed, 0.25);
    g.knob = Math.max(0, Math.min(1, Math.max(g.knob - maxDelta, Math.min(g.knob + maxDelta, value))));
    return OK;
  }

  setDrawer(sessionId: string, value: number): IntentResult {
    const p = this.player(sessionId);
    if (!p) return fail("Not connected");
    const h = CHILLER_DRAWER.handle;
    const handle = { x: h[0], y: h[1], z: h[2] - this.state.drawer * CHILLER_DRAWER.travel };
    const reach = this.canReach(p, handle, 0.15);
    if (!reach.ok) return reach;
    const elapsed = Math.max(1, this.state.tick - p.lastDrawerTick) / NET.tickHz;
    p.lastDrawerTick = this.state.tick;
    const maxDelta = INTERACTION.drawerMaxRate * Math.min(elapsed, 0.25);
    const cur = this.state.drawer;
    this.state.drawer = Math.max(0, Math.min(1, Math.max(cur - maxDelta, Math.min(cur + maxDelta, value))));
    return OK;
  }

  spatula(sessionId: string, action: "slide" | "flip" | "assistFlip", itemId?: string, rev?: number): IntentResult {
    const p = this.player(sessionId);
    if (!p) return fail("Not connected");
    if (this.state.paused) return fail("The room is paused");
    const sp = this.heldItem(p);
    if (!sp || sp.kind !== "spatula") return fail("Grab the spatula first");

    if (action === "flip") {
      const load = sp.child ? this.items.get(sp.child)! : null;
      if (!load) return fail("Slide the spatula under something first");
      if (load.child) return fail("Take the cheese off before flipping");
      // Flip lands on the surface under the blade.
      const below = this.pw.castStatic({ x: load.pos.x, y: load.pos.y + 0.05, z: load.pos.z }, { x: 0, y: -1, z: 0 }, 1.5);
      if (below === null) return fail("Hold it over the grill to flip");
      const landing = { x: load.pos.x, y: load.pos.y + 0.05 - below, z: load.pos.z };
      const surf = surfaceAt(landing, 0.04);
      if (!surf || surf.kind === "floor") return fail("Hold it over the grill to flip");
      const spot = this.resolveSpot(load, { x: landing.x, y: surf.y, z: landing.z }, surf.kind === "grill");
      if (!spot.pos) return fail("No room to flip it there");
      this.detach(load);
      this.startFlip(load, spot.pos);
      return OK;
    }

    if (sp.child) return fail("The spatula is already carrying something");
    if (!itemId) return fail("Aim at something to slide under");
    const target = this.items.get(itemId);
    if (!target) return fail("That's gone");
    if (rev !== undefined && target.s.rev !== rev) return fail("Someone else got there first");
    const root = this.rootOf(target);
    if (root.holder || root.locked || root.flip) return fail("That's busy");
    if (!ITEMS.spatula.accepts.includes(root.kind)) return fail("The spatula is for things on the grill");
    const reach = this.canReach(p, { x: root.pos.x, y: root.pos.y + 0.02, z: root.pos.z });
    if (!reach.ok) return reach;

    if (action === "assistFlip") {
      if (!isPatty(root.kind) && root.kind !== "bacon") return fail("Only patties and bacon need flipping");
      if (root.child) return fail("Take the cheese off before flipping");
      this.removeBody(root);
      this.startFlip(root, { ...root.pos });
      return OK;
    }
    // slide: lift the root (and anything on it, e.g. melted cheese) onto the blade.
    if (this.stackFrom(root).length > 2) return fail("Too much on it for the spatula");
    this.removeBody(root);
    root.zone = -1;
    this.attach(sp, root);
    this.layoutStack(sp);
    return OK;
  }

  private startFlip(it: ItemRt, at: V3): void {
    this.removeBody(it);
    it.flip = { t: 0, at, yaw: yawOf(it.rot) };
    it.zone = -1;
    this.bump(it);
  }

  squeeze(sessionId: string, targetId: string, intensity: number): IntentResult {
    const p = this.player(sessionId);
    if (!p) return fail("Not connected");
    if (this.state.paused) return fail("The room is paused");
    const bottle = this.heldItem(p);
    const sauceKind = bottle ? ITEMS[bottle.kind].sauce : undefined;
    if (!bottle || !sauceKind) return fail("Grab a sauce bottle first");
    const target = this.items.get(targetId);
    if (!target) return fail("That's gone");
    const top = this.topOf(this.rootOf(target));
    if (!top.food) return fail("Sauce goes on food");
    if (top.kind === "bun_top") return fail("Sauce goes under the top bun");
    const reach = this.canReach(p, top.pos);
    if (!reach.ok) return reach;
    const elapsed = Math.min(0.15, Math.max(1, this.state.tick - p.lastSqueezeTick) / NET.tickHz);
    p.lastSqueezeTick = this.state.tick;
    if (bottle.level <= 0) {
      const left = this.state.stock.get("sauce") ?? 0;
      if (left <= 0) return fail("Out of sauce");
      this.state.stock.set("sauce", left - 1);
      this.state.costs += 10;
      bottle.level = 1;
      this.hooks.toast(sessionId, "Refilled the sauce bottle", "info");
    }
    const amount = Math.min(bottle.level * 4, INTERACTION.sauceFlowRate * intensity * elapsed);
    top.food.sauce = Math.min(2, top.food.sauce + amount);
    if (amount > 0.005) top.food.sauceMask |= SAUCE_BIT[sauceKind];
    bottle.level = Math.max(0, bottle.level - amount / 4);
    bottle.s.level = Math.round(bottle.level * 255);
    return OK;
  }

  shiftSwitch(sessionId: string, action: "open" | "close"): IntentResult {
    const p = this.player(sessionId);
    if (!p) return fail("Not connected");
    const reach = this.canReach(p, { x: SHIFT_SWITCH[0], y: SHIFT_SWITCH[1], z: SHIFT_SWITCH[2] }, 0.2);
    if (!reach.ok) return reach;
    if (action === "open") {
      if (this.state.phase !== "prep") return fail("The restaurant is already open");
      this.openShift();
      this.hooks.broadcastToast(`${p.s.name} opened the restaurant`, "success");
      return OK;
    }
    if (this.state.phase !== "open") return fail("The restaurant isn't open");
    this.state.phase = "closing";
    this.state.shiftSwitch = false;
    this.hooks.broadcastToast(`${p.s.name} flipped the sign to CLOSED — finish the open tickets`, "info");
    return OK;
  }

  private openShift(): void {
    this.shiftId = randomUUID();
    this.state.phase = "open";
    this.state.shiftSwitch = true;
    this.state.shiftTime = 0;
    this.state.revenue = 0;
    this.state.costs = 0;
    this.state.waste = 0;
    this.state.served = 0;
    this.refused = 0;
    this.nextOrderAt = 4;
    for (const [id, o] of this.orders) {
      this.orders.delete(id);
      this.state.orders.delete(id);
      void o;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Pause / resume (spec §5, §13)

  requestPause(sessionId: string): IntentResult {
    if (!this.players.has(sessionId)) return fail("Not connected");
    if (this.state.paused) return fail("Already paused");
    if (this.connectedCount() <= 1) {
      this.pause("Paused");
      return OK;
    }
    if (!this.state.pauseVotes.includes(sessionId)) this.state.pauseVotes.push(sessionId);
    const connected = [...this.players.values()].filter((q) => q.s.connected).map((q) => q.id);
    if (connected.every((id) => this.state.pauseVotes.includes(id))) {
      this.pause("Paused by team vote");
    } else {
      this.hooks.broadcastToast(`${this.players.get(sessionId)!.s.name} wants to pause (${this.state.pauseVotes.length}/${connected.length})`, "info");
    }
    return OK;
  }

  cancelPauseVote(sessionId: string): IntentResult {
    const i = this.state.pauseVotes.indexOf(sessionId);
    if (i >= 0) this.state.pauseVotes.splice(i, 1);
    return OK;
  }

  requestResume(sessionId: string): IntentResult {
    if (!this.players.has(sessionId)) return fail("Not connected");
    if (!this.state.paused) return fail("Not paused");
    if (this.state.resumeTick === 0) this.state.resumeTick = this.state.tick + ROOM.resumeCountdownSeconds * NET.tickHz;
    return OK;
  }

  pause(reason: string): void {
    this.state.paused = true;
    this.state.pauseReason = reason;
    this.state.resumeTick = 0;
    this.state.pauseVotes.splice(0, this.state.pauseVotes.length);
    for (const p of this.players.values()) p.queue.length = 0;
    for (const it of this.items.values()) it.body?.sleep();
  }

  private resume(): void {
    this.state.paused = false;
    this.state.pauseReason = "";
    this.state.resumeTick = 0;
  }

  // ---------------------------------------------------------------------------------------
  // Serving

  /**
   * A tray on the pickup shelf carrying a closed burger is handed to the customer. Adding layers
   * to an open burger that happens to sit on the shelf does not serve it.
   */
  private checkPickup(root: ItemRt, by: string): void {
    const r = this.rootOf(root);
    if (r.kind !== "tray" || r.holder || r.locked || !r.child) return;
    if (!inPickupZone({ x: r.pos.x, y: r.pos.y - restingHeight("tray"), z: r.pos.z })) return;
    const stack = this.stackFrom(r);
    const sig = stack.map((i) => `${i.id}:${i.s.rev}`).join(",");
    if (sig === r.serveSig) return;
    r.serveSig = sig;
    if (stack[stack.length - 1]!.kind !== "bun_top") {
      if (by) this.hooks.toast(by, "Close the burger with a top bun before serving", "warn");
      return;
    }
    this.tryServe(r, by);
  }

  private tryServe(tray: ItemRt, by: string): void {
    const open = [...this.orders.values()].filter((o) => o.s.status === "open" && !o.reservedBy);
    if (open.length === 0) {
      this.hooks.toast(by, "No customer is waiting for that yet", "warn");
      return;
    }
    const stack = this.stackFrom(tray).slice(1);
    const layers: ServedLayer[] = stack.map((it) => ({ kind: it.kind, food: it.food ?? createFoodState(it.kind) }));
    let best: { o: OrderRt; e: Evaluation } | null = null;
    for (const o of open.sort((a, b) => a.s.createdAt - b.s.createdAt)) {
      const e = evaluateBurger(
        layers,
        { recipe: o.s.recipe as RecipeId, modifiers: [...o.s.modifiers] as ModifierId[] },
        this.state.shiftTime - o.s.createdAt,
        SHIFT.patienceSeconds,
      );
      if (!best || e.score > best.e.score) best = { o, e };
    }
    if (!best) return;
    const refuse = this.state.mode === "normal" ? !best.e.accepted : best.e.score === 0;
    if (refuse) {
      this.refused++;
      this.hooks.broadcastToast(`Order #${best.o.s.number} refused: ${best.e.feedback.slice(0, 2).join(", ")}`, "warn");
      return;
    }
    if (best.e.priceCents === 0) {
      best.e = { ...best.e, accepted: true, priceCents: Math.round(RECIPES[best.o.s.recipe as RecipeId].priceCents * 0.5) };
    }
    tray.locked = true;
    tray.s.holder = "__counter";
    this.removeBody(tray);
    best.o.reservedBy = tray.id;
    this.hooks.requestServe({
      trayId: tray.id,
      orderId: best.o.id,
      orderNumber: best.o.s.number,
      orderKey: `${this.shiftId}:${best.o.s.number}`,
      shiftId: this.shiftId,
      evaluation: best.e,
      servedItemIds: stack.map((i) => i.id),
      by,
    });
  }

  /** Called after the sale has committed (or was found already committed). */
  completeServe(req: ServeRequest, balanceAfterCents: number): void {
    const order = this.orders.get(req.orderId);
    if (order) {
      order.s.status = "served";
      order.s.score = req.evaluation.score;
      order.reservedBy = null;
    }
    const tray = this.items.get(req.trayId);
    if (tray) {
      // The customer takes the food; the tray returns to the counter empty.
      if (tray.child) this.destroyStack(this.items.get(tray.child)!, false);
      tray.locked = false;
      tray.s.holder = "";
      tray.pos = { x: tray.pos.x, y: tray.pos.y, z: Math.min(tray.pos.z + 0.12, 0.3) };
      this.ensureBody(tray);
      this.bump(tray);
    }
    this.state.revenue += req.evaluation.priceCents + req.evaluation.tipCents;
    this.state.balance = balanceAfterCents;
    this.state.served += 1;
  }

  /** Called when the payment could not be committed; nothing was handed over. */
  abortServe(req: ServeRequest): void {
    const order = this.orders.get(req.orderId);
    if (order) order.reservedBy = null;
    const tray = this.items.get(req.trayId);
    if (tray) {
      tray.locked = false;
      tray.s.holder = "";
      this.ensureBody(tray);
      this.bump(tray);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Simulation

  step(dt: number): void {
    const st = this.state;
    st.tick = (st.tick + 1) >>> 0;
    if (st.paused) {
      if (st.resumeTick !== 0 && st.tick >= st.resumeTick) this.resume();
      return;
    }

    // Players: consume exactly the samples each client simulated, one per tick, with bounded
    // catch-up credit so a client cannot move faster than real time on average.
    for (const p of this.players.values()) {
      p.credit = Math.min(8, p.credit + 1);
      const n = p.queue.length > 4 ? 2 : 1;
      for (let i = 0; i < n && p.credit >= 1; i++) {
        const sample = p.queue.shift();
        if (!sample) break;
        p.credit -= 1;
        const held = this.heldItem(p);
        const factor = held?.kind === "tray" ? PLAYER.carrySpeedFactor : 1;
        const m = p.motor.step(sample, dt, factor);
        p.crouch = (sample.buttons & BUTTON_CROUCH) !== 0;
        p.s.ack = sample.seq;
        p.s.yaw = sample.yaw;
        p.s.pitch = sample.pitch;
        p.s.crouch = p.crouch;
        p.s.x = m.x;
        p.s.y = m.y;
        p.s.z = m.z;
        p.s.vx = m.vx;
        p.s.vy = m.vy;
        p.s.vz = m.vz;
      }
      if (st.tick - p.lastInputTick > (NET.staleInputMs / 1000) * NET.tickHz) p.queue.length = 0;
      if (p.s.hold !== p.hold) p.s.hold = p.hold;
    }

    // Held items follow their holder's hands, clamped so they never pass through walls.
    for (const p of this.players.values()) {
      const held = this.heldItem(p);
      if (!held) continue;
      const eye = this.eye(p);
      const dir = lookDirection(p.s.yaw, p.s.pitch);
      let d = p.hold;
      const hit = this.pw.castStatic(eye, dir, d + 0.1);
      if (hit !== null) d = Math.max(0.2, hit - 0.1);
      const handDrop = held.kind === "tray" ? 0.18 : 0.1;
      held.pos = { x: eye.x + dir.x * d, y: eye.y + dir.y * d - handDrop, z: eye.z + dir.z * d };
      held.rot = held.kind === "tray" ? quatYaw(p.s.yaw) : quatMul(quatYaw(p.s.yaw + p.rotYaw), quatAxisX(p.rotPitch));
      if (held.offeredTo && (st.tick > held.offeredUntil || !this.players.get(held.offeredTo)?.s.connected)) {
        held.offeredTo = null;
        held.s.offered = false;
      }
    }

    // Assisted flips: a short authored arc; the patty leaves the grill and lands flipped.
    for (const it of this.items.values()) {
      if (!it.flip) continue;
      const f = it.flip;
      const before = f.t;
      f.t = Math.min(1, f.t + dt / INTERACTION.flipDuration);
      if (before < 0.5 && f.t >= 0.5 && it.food) it.food.down = it.food.down === 0 ? 1 : 0;
      const arc = Math.sin(Math.PI * f.t) * 0.12;
      it.pos = { x: f.at.x, y: f.at.y + arc, z: f.at.z };
      it.rot = quatMul(quatYaw(f.yaw), quatAxisX(Math.PI * f.t));
      it.s.flip = Math.max(1, Math.round(f.t * 255));
      if (f.t >= 1) {
        it.flip = null;
        it.s.flip = 0;
        it.pos = { ...f.at };
        it.rot = quatYaw(f.yaw);
        this.ensureBody(it);
        it.body?.sleep();
        this.bump(it);
      }
    }

    this.pw.world.step();

    // Pull physics results back into items, and handle floor, trash and out-of-world cases.
    for (const it of [...this.items.values()]) {
      if (!it.body) continue;
      const t = it.body.translation();
      const r = it.body.rotation();
      it.pos = { x: t.x, y: t.y, z: t.z };
      it.rot = { x: r.x, y: r.y, z: r.z, w: r.w };
      if (inTrashZone(it.pos) && (ITEMS[it.kind].food || it.kind === "tray")) {
        if (it.kind === "tray") {
          if (it.child) this.destroyStack(this.items.get(it.child)!, true);
          this.respawnTool(it);
        } else {
          this.destroyStack(it, true);
        }
        continue;
      }
      if (it.pos.y < -1 || Math.abs(it.pos.x) > 7 || it.pos.z < -7 || it.pos.z > 6) {
        if (ITEMS[it.kind].food) this.destroyStack(it, true);
        else this.respawnTool(it);
        continue;
      }
      if (it.pos.y < 0.12) {
        for (const layer of this.stackFrom(it)) if (layer.food && !layer.food.dirty) layer.food.dirty = true;
      }
      if (it.kind === "tray" && it.body.isSleeping() && it.child && !it.locked) this.checkPickup(it, "");
    }

    // Stacks follow their roots.
    for (const it of this.items.values()) if (!it.parent && it.child) this.layoutStack(it);

    // Grill temperatures follow the knobs.
    GRILL_ZONES.forEach((_, i) => {
      const g = st.grill[i]!;
      this.grillTemps[i] = stepGrillTemp(this.grillTemps[i]!, g.knob, dt);
      const t = Math.round(Math.min(255, this.grillTemps[i]!));
      if (g.temp !== t) g.temp = t;
    });

    // Cooking.
    for (const it of this.items.values()) {
      if (!it.food) continue;
      let contact: number | null = null;
      if (!it.parent && !it.holder && !it.flip) {
        const zone = grillZoneAt(it.pos.x, it.pos.y - restingHeight(it.kind), it.pos.z);
        it.zone = zone;
        if (zone >= 0) contact = this.grillTemps[zone]!;
      } else {
        it.zone = -1;
      }
      const parent = it.parent ? this.items.get(it.parent) : undefined;
      const below = parent?.food ? parent.food.temp : null;
      stepFood(it.kind, it.food, { contactTemp: contact, belowTemp: below }, dt);
    }

    if (st.phase === "open" || st.phase === "closing") this.stepOrders(dt);
    this.syncAll();
  }

  private respawnTool(it: ItemRt): void {
    const home = INITIAL_ITEMS.find((i) => i.kind === it.kind);
    this.removeBody(it);
    if (it.child) this.destroyStack(this.items.get(it.child)!, true);
    it.pos = home ? { x: home.position[0], y: home.position[1] + 0.05, z: home.position[2] } : { x: 0, y: 1.0, z: 2.2 };
    it.rot = quatYaw(home?.yaw ?? 0);
    this.ensureBody(it);
    this.bump(it);
  }

  private layoutStack(root: ItemRt): void {
    const stack = this.stackFrom(root);
    if (stack.length < 2) return;
    const offsets = stackOffsets(stack.map((i) => i.kind));
    // On a spatula the load sits toward the blade end.
    const forward = root.kind === "spatula" ? 0.07 : 0;
    for (let i = 1; i < stack.length; i++) {
      const it = stack[i]!;
      const local = rotate(root.rot, { x: 0, y: offsets[i]!, z: forward });
      it.pos = { x: root.pos.x + local.x, y: root.pos.y + local.y, z: root.pos.z + local.z };
      it.rot = root.rot;
    }
  }

  private stepOrders(dt: number): void {
    const st = this.state;
    st.shiftTime += dt;
    const players = Math.max(1, this.connectedCount());
    if (st.phase === "open") {
      const base = st.mode === "relaxed" ? SHIFT.relaxedOrderInterval : SHIFT.normalOrderInterval;
      const interval = base / (1 + SHIFT.perPlayerPressure * (players - 1));
      const openCount = [...this.orders.values()].filter((o) => o.s.status === "open").length;
      const maxOpen = SHIFT.maxOpenOrdersBase + players - 1;
      if (st.shiftTime >= this.nextOrderAt) {
        if (openCount < maxOpen) this.createOrder(this.randomRecipe());
        this.nextOrderAt = st.shiftTime + interval * (0.75 + this.rng() * 0.5);
      }
      if (st.mode === "normal" && st.shiftTime >= SHIFT.normalShiftSeconds) {
        st.phase = "closing";
        st.shiftSwitch = false;
        this.hooks.broadcastToast("Last orders — the shift is closing", "info");
      }
    }
    // Customers eventually give up in normal mode; relaxed mode lets you practise.
    if (st.mode === "normal") {
      for (const o of this.orders.values()) {
        if (o.s.status === "open" && !o.reservedBy && st.shiftTime - o.s.createdAt > SHIFT.patienceSeconds * 2) {
          o.s.status = "cancelled";
          this.hooks.broadcastToast(`Customer #${o.s.number} got tired of waiting and left`, "warn");
        }
      }
    }
    if (st.phase === "closing" && ![...this.orders.values()].some((o) => o.s.status === "open")) {
      st.phase = "prep";
      st.shiftSwitch = false;
      this.hooks.shiftEnded({ shiftId: this.shiftId, revenue: st.revenue, costs: st.costs, waste: st.waste, served: st.served, refused: this.refused });
    }
  }

  /** Recipes unlock in tiers as the shift goes on, so the menu grows while cooks learn it. */
  unlockedRecipes(): RecipeId[] {
    const st = this.state;
    const mode = st.mode === "normal" ? "normal" : "relaxed";
    const tier = st.shiftTime >= SHIFT.tier3After[mode] ? 3 : st.shiftTime >= SHIFT.tier2After[mode] ? 2 : 1;
    return RECIPE_IDS.filter((id) => RECIPES[id].enabled && RECIPES[id].tier <= tier);
  }

  private randomRecipe(): RecipeId {
    const pool = this.unlockedRecipes();
    return pool[Math.floor(this.rng() * pool.length)] ?? "classic_cheeseburger";
  }

  createOrder(recipe: RecipeId = "classic_cheeseburger", modifiers?: ModifierId[]): OrderState {
    const st = this.state;
    const number = st.nextOrder;
    st.nextOrder = number >= 999 ? 1 : number + 1;
    const o = new OrderState();
    o.number = number;
    o.recipe = recipe;
    o.createdAt = st.shiftTime;
    o.status = "open";
    const mods = modifiers ?? this.randomModifiers(recipe);
    for (const m of mods) o.modifiers.push(m);
    const id = `o${number}_${Math.floor(st.shiftTime * 10)}`;
    this.orders.set(id, { id, s: o, reservedBy: null });
    st.orders.set(id, o);
    // Keep the rail short: drop finished tickets beyond the latest few.
    const finished = [...this.orders.values()].filter((x) => x.s.status !== "open").sort((a, b) => a.s.createdAt - b.s.createdAt);
    while (finished.length > 4) {
      const old = finished.shift()!;
      this.orders.delete(old.id);
      st.orders.delete(old.id);
    }
    return o;
  }

  private randomModifiers(recipe: RecipeId): ModifierId[] {
    if (this.rng() > SHIFT.modifierChance) return [];
    const options = modifiersFor(recipe);
    if (options.length === 0) return [];
    return [options[Math.floor(this.rng() * options.length)]!];
  }

  /** Writes runtime values into replicated state, only where they changed. */
  private syncAll(): void {
    for (const it of this.items.values()) {
      const s = it.s;
      const eps = 0.0005;
      if (Math.abs(s.x - it.pos.x) > eps) s.x = it.pos.x;
      if (Math.abs(s.y - it.pos.y) > eps) s.y = it.pos.y;
      if (Math.abs(s.z - it.pos.z) > eps) s.z = it.pos.z;
      const reps = 0.001;
      if (Math.abs(s.qx - it.rot.x) > reps || Math.abs(s.qy - it.rot.y) > reps || Math.abs(s.qz - it.rot.z) > reps || Math.abs(s.qw - it.rot.w) > reps) {
        s.qx = it.rot.x;
        s.qy = it.rot.y;
        s.qz = it.rot.z;
        s.qw = it.rot.w;
      }
      const on = it.parent ?? "";
      if (s.on !== on) s.on = on;
      const root = it.parent ? this.rootOf(it).id : "";
      if (s.root !== root) s.root = root;
      const layer = it.parent ? this.stackFrom(this.rootOf(it)).indexOf(it) : 0;
      if (s.layer !== layer) s.layer = layer;
      if (s.zone !== it.zone) s.zone = it.zone;
      if (it.food) writeFoodBytes(s, it.food);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Safety

  /** Puts down whatever a leaving or backgrounded player holds, without losing it. */
  private safelyRelease(p: PlayerRt): void {
    const held = this.heldItem(p);
    if (!held) return;
    const spot = this.findRestSpot(held, this.eye(p), lookDirection(p.s.yaw, Math.min(0.9, Math.max(0.4, p.s.pitch))), null);
    this.releaseHold(p, held);
    if (spot?.stackOn && canAddToStack(this.stackFrom(spot.stackOn).map((i) => i.kind), held.kind).ok) {
      this.attach(spot.stackOn, held);
      this.layoutStack(spot.stackOn);
    } else if (spot?.pos) {
      held.pos = spot.pos;
      held.rot = quatYaw(p.s.yaw);
      this.ensureBody(held);
    } else {
      this.ensureBody(held);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Persistence

  snapshot(): KitchenSnapshot {
    const st = this.state;
    return {
      v: 1,
      itemSeq: this.itemSeq,
      phase: st.phase,
      mode: st.mode as "relaxed" | "normal",
      shiftId: this.shiftId,
      shiftTime: st.shiftTime,
      nextOrderAt: this.nextOrderAt,
      revenue: st.revenue,
      costs: st.costs,
      waste: st.waste,
      served: st.served,
      refused: this.refused,
      nextOrder: st.nextOrder,
      drawer: st.drawer,
      knobs: st.grill.map((g) => g.knob),
      grillTemps: [...this.grillTemps],
      items: [...this.items.values()].map((it) => ({
        id: it.id,
        kind: it.kind,
        pos: [it.flip ? it.flip.at.x : it.pos.x, it.flip ? it.flip.at.y : it.pos.y, it.flip ? it.flip.at.z : it.pos.z],
        rot: [it.rot.x, it.rot.y, it.rot.z, it.rot.w],
        parent: it.parent,
        food: it.food ? { ...it.food } : null,
        level: it.level,
      })),
      orders: [...this.orders.values()].map((o) => ({
        id: o.id,
        number: o.s.number,
        recipe: o.s.recipe as RecipeId,
        modifiers: [...o.s.modifiers] as ModifierId[],
        createdAt: o.s.createdAt,
        status: o.reservedBy ? "open" : o.s.status,
        score: o.s.score,
      })),
    };
  }

  /**
   * Restores a checkpoint. Orders whose sale already committed are marked served and their
   * handed-over items removed, so a served burger never reappears beside a credited payment.
   */
  restore(snap: KitchenSnapshot, committed: { orderNumber: number; score: number; servedItemIds: string[] }[]): void {
    for (const it of [...this.items.values()]) {
      this.removeBody(it);
      this.items.delete(it.id);
      this.state.items.delete(it.id);
    }
    const st = this.state;
    this.itemSeq = snap.itemSeq;
    this.shiftId = snap.shiftId;
    st.phase = snap.phase;
    st.mode = snap.mode;
    st.shiftTime = snap.shiftTime;
    this.nextOrderAt = snap.nextOrderAt;
    st.revenue = snap.revenue;
    st.costs = snap.costs;
    st.waste = snap.waste;
    st.served = snap.served;
    this.refused = snap.refused;
    st.nextOrder = snap.nextOrder;
    st.drawer = snap.drawer;
    st.shiftSwitch = snap.phase === "open";
    snap.knobs.forEach((k, i) => {
      const g = st.grill[i];
      if (g) g.knob = k;
    });
    snap.grillTemps.forEach((t, i) => (this.grillTemps[i] = t));

    const servedIds = new Set(committed.flatMap((c) => c.servedItemIds));
    for (const s of snap.items) {
      if (servedIds.has(s.id)) continue;
      const it = this.createItem(s.kind, { x: s.pos[0], y: s.pos[1], z: s.pos[2] }, { x: s.rot[0], y: s.rot[1], z: s.rot[2], w: s.rot[3] }, s.id);
      if (s.food && it.food) Object.assign(it.food, s.food);
      it.level = s.level;
      it.s.level = Math.round(s.level * 255);
    }
    for (const s of snap.items) {
      if (servedIds.has(s.id) || !s.parent) continue;
      const it = this.items.get(s.id);
      const parent = this.items.get(s.parent);
      if (it && parent && !parent.child) {
        parent.child = it.id;
        it.parent = parent.id;
      }
    }
    for (const it of this.items.values()) {
      // Items that sat on a spatula or in someone's hands come back as loose, resting items.
      if (it.parent) continue;
      if (it.kind === "spatula" && it.child) {
        const load = this.items.get(it.child)!;
        load.parent = null;
        it.child = null;
        const spot = this.findRestSpot(load, { x: load.pos.x, y: load.pos.y + 0.5, z: load.pos.z }, { x: 0, y: -1, z: 0 }, null);
        if (spot?.pos) load.pos = spot.pos;
      }
    }
    for (const it of this.items.values()) {
      if (!it.parent) {
        this.ensureBody(it);
        it.body?.sleep();
        this.layoutStack(it);
      }
    }
    const committedNumbers = new Map(committed.map((c) => [c.orderNumber, c]));
    for (const o of snap.orders) {
      const os = new OrderState();
      os.number = o.number;
      os.recipe = o.recipe;
      for (const m of o.modifiers) os.modifiers.push(m);
      os.createdAt = o.createdAt;
      const paid = committedNumbers.get(o.number);
      os.status = paid ? "served" : o.status;
      os.score = paid ? paid.score : o.score;
      this.orders.set(o.id, { id: o.id, s: os, reservedBy: null });
      st.orders.set(o.id, os);
    }
    this.syncAll();
  }

  stockRecord(): Record<StockKey, number> {
    const out = {} as Record<StockKey, number>;
    for (const key of STOCK_KEYS) out[key] = this.state.stock.get(key) ?? 0;
    return out;
  }

  /** Test/diagnostic helpers. */
  debugItem(id: string): { pos: V3; holder: string | null; parent: string | null; food: FoodState | null; zone: number } | null {
    const it = this.items.get(id);
    return it ? { pos: { ...it.pos }, holder: it.holder, parent: it.parent, food: it.food ? { ...it.food } : null, zone: it.zone } : null;
  }

  debugPlacePlayer(sessionId: string, pos: V3, yaw: number, pitch: number): void {
    const p = this.players.get(sessionId);
    if (!p) return;
    p.motor.reset({ ...pos, vx: 0, vy: 0, vz: 0 });
    p.s.x = pos.x;
    p.s.y = pos.y;
    p.s.z = pos.z;
    p.s.yaw = yaw;
    p.s.pitch = pitch;
  }

  dispose(): void {
    for (const p of this.players.values()) p.motor.dispose();
    for (const it of this.items.values()) this.removeBody(it);
    this.players.clear();
    this.items.clear();
  }
}

