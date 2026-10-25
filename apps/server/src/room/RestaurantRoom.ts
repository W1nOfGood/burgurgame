import { randomBytes } from "node:crypto";
import { Room, ServerError, matchMaker, type AuthContext, type Client } from "@colyseus/core";
import { NET, ROOM, type DrinkId, type StockKey } from "@ahb/data";
import { createPhysicsWorld, type PhysicsWorld, type Rapier } from "@ahb/simulation";
import {
  MSG,
  PROTOCOL_VERSION,
  RestaurantState,
  SERVER_MSG,
  awaySchema,
  cmdOnlySchema,
  drawerSchema,
  grabSchema,
  inputSchema,
  joinOptionsSchema,
  knobSchema,
  offerSchema,
  pauseSchema,
  pingSchema,
  placeSchema,
  shiftSchema,
  tutorialSchema,
  buySchema,
  ringSchema,
  spatulaSchema,
  squeezeSchema,
  type JoinOptions,
  type ResultMessage,
  type ServedMessage,
  type SummaryMessage,
  type ToastMessage,
  type WelcomeMessage,
} from "@ahb/protocol";
import { z } from "zod";
import { verifyGuestToken } from "../auth.js";
import type { ServerConfig } from "../config.js";
import { log } from "../log.js";
import { LeaseLostError, type Lease, type Store } from "../store/index.js";
import { Kitchen, type IntentResult, type KitchenSnapshot, type ServeRequest, type ShiftSummary, type Tone } from "./kitchen.js";

export interface RoomDeps {
  store: Store;
  config: ServerConfig;
  R: Rapier;
}

interface AuthData {
  profileId: string;
}

interface Session {
  profileId: string;
  name: string;
  /** cmd id → result, bounded, for idempotent retries of discrete intents. */
  results: Map<number, ResultMessage>;
  tokens: number;
  lastRefill: number;
}

const RESULT_CACHE = 128;

const debugTeleportSchema = z.object({ x: z.number().min(-6).max(6), z: z.number().min(-6).max(5), yaw: z.number().min(-10).max(10), pitch: z.number().min(-1.5).max(1.5) });

function isAllowedOrigin(config: ServerConfig, origin: string | null | undefined): boolean {
  if (!origin) return !config.production;
  return config.allowedOrigins.includes(origin);
}

export class RestaurantRoom extends Room<{ state: RestaurantState }> {
  static deps: RoomDeps | null = null;
  static activeRooms = 0;

  static configure(deps: RoomDeps): void {
    RestaurantRoom.deps = deps;
  }

  /**
   * Runs during matchmaking, before any seat is reserved: verifies the guest credential, the
   * browser origin, and the join options. The result becomes `client.auth`.
   */
  static override async onAuth(token: string, options: unknown, context: AuthContext): Promise<AuthData> {
    const deps = RestaurantRoom.deps;
    if (!deps) throw new ServerError(503, "Server not ready");
    if (!isAllowedOrigin(deps.config, context.headers?.get?.("origin"))) throw new ServerError(403, "Origin not allowed");
    const parsed = joinOptionsSchema.safeParse(options);
    if (!parsed.success) {
      const versionIssue = (options as { protocol?: unknown } | null)?.protocol !== PROTOCOL_VERSION;
      throw new ServerError(400, versionIssue ? "Game version mismatch — reload the page" : "Invalid join options");
    }
    const id = verifyGuestToken(deps.config.guestTokenSecret, token);
    if (!id) throw new ServerError(401, "Guest session missing or invalid");
    const profile = await deps.store.getProfile(id.profileId);
    if (!profile) throw new ServerError(401, "Guest profile not found");
    return { profileId: profile.id };
  }

  override maxClients = ROOM.maxPlayers;
  override autoDispose = true;
  override patchRate = 1000 / NET.patchHz;
  override maxMessagesPerSecond = 160;

  private deps!: RoomDeps;
  private pw: PhysicsWorld | null = null;
  kitchen: Kitchen | null = null;
  private initializing: Promise<void> | null = null;
  private sessions = new Map<string, Session>();
  restaurantId = "";
  private ownerProfileId = "";
  private lease: Lease | null = null;
  private leaseHolder = "";
  private lastSavedAt = Date.now();
  private saving = false;
  private disposed = false;
  private counted = false;

  override async onCreate(options: unknown): Promise<void> {
    const deps = RestaurantRoom.deps;
    if (!deps) throw new ServerError(503, "Server not ready");
    this.deps = deps;
    if (RestaurantRoom.activeRooms >= deps.config.maxRooms) throw new ServerError(503, "The server is at capacity — try again later");
    RestaurantRoom.activeRooms++;
    this.counted = true;
    this.roomId = await this.uniqueCode();
    await this.setPrivate(true);
    this.leaseHolder = `${this.roomId}-${randomBytes(6).toString("hex")}`;
    const parsed = joinOptionsSchema.safeParse(options);
    const state = new RestaurantState();
    state.protocol = PROTOCOL_VERSION;
    state.mode = parsed.success ? (parsed.data.mode ?? "relaxed") : "relaxed";
    state.phase = "loading";
    this.state = state;
    this.pw = createPhysicsWorld(deps.R, 1 / NET.tickHz);

    this.setFixedTimestep((ctx) => {
      this.kitchen?.step(ctx.dt);
    }, NET.tickHz);
    this.clock.setInterval(() => void this.checkpoint("interval"), ROOM.checkpointIntervalMs);
    this.registerMessages();
  }

  private async uniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const bytes = randomBytes(ROOM.codeLength);
      let code = "";
      for (let i = 0; i < ROOM.codeLength; i++) code += ROOM.codeAlphabet[bytes[i]! % ROOM.codeAlphabet.length];
      const existing = await matchMaker.query({ roomId: code });
      if (existing.length === 0) return code;
    }
    throw new ServerError(503, "Could not allocate a room code");
  }

  override async onJoin(client: Client, options: unknown): Promise<void> {
    const opts = joinOptionsSchema.parse(options) as JoinOptions;
    const auth = client.auth as AuthData;
    if ([...this.sessions.values()].some((s) => s.profileId === auth.profileId)) {
      throw new ServerError(409, "You're already in this kitchen in another tab");
    }
    if (!this.kitchen) {
      if (!this.initializing) {
        this.initializing = this.initialize(auth.profileId, opts);
        this.initializing.catch(() => (this.initializing = null));
      }
      await this.initializing;
    }
    const kitchen = this.kitchen!;
    this.sessions.set(client.sessionId, { profileId: auth.profileId, name: opts.name, results: new Map(), tokens: NET.maxIntentsPerSecond, lastRefill: Date.now() });
    kitchen.addPlayer(client.sessionId, { name: opts.name, platform: opts.platform });
    client.send(SERVER_MSG.welcome, this.welcomeFor(client.sessionId));
    this.afterPresenceChange();
    log.info("player joined", { room: this.roomId, session: client.sessionId, players: this.clients.length });
  }

  /** First join opens the restaurant: ownership check, write lease, checkpoint restore. */
  private async initialize(profileId: string, opts: JoinOptions): Promise<void> {
    const { store } = this.deps;
    let restaurantId = opts.restaurantId;
    if (restaurantId) {
      if (!(await store.canOpen(profileId, restaurantId))) throw new ServerError(403, "You don't have access to that restaurant");
    } else {
      const owned = await store.listRestaurants(profileId);
      restaurantId = owned[0]?.id ?? (await store.createRestaurant(profileId, `${opts.name}'s Burgers`)).id;
    }
    const restaurant = await store.getRestaurant(restaurantId);
    if (!restaurant) throw new ServerError(404, "Restaurant not found");
    const lease = await store.acquireLease(restaurantId, this.leaseHolder, ROOM.leaseTtlMs);
    if (!lease) throw new ServerError(409, "That restaurant is already open in another room");
    this.lease = lease;
    this.restaurantId = restaurantId;
    this.ownerProfileId = restaurant.ownerId;

    const kitchen = new Kitchen(this.pw!, this.state, this.hooks(), {
      mode: (this.state.mode as "relaxed" | "normal") ?? "relaxed",
      stock: restaurant.stock,
      balanceCents: restaurant.balanceCents,
      name: restaurant.name,
    });
    const checkpoint = await store.loadCheckpoint(restaurantId);
    if (checkpoint && (checkpoint.snapshot as KitchenSnapshot | null)?.v === 1) {
      const snap = checkpoint.snapshot as KitchenSnapshot;
      const sales = snap.shiftId ? await store.salesForShift(restaurantId, snap.shiftId) : [];
      kitchen.restore(snap, sales);
      // A resumed restaurant starts paused so nothing burns before the team is ready.
      if (snap.phase !== "prep") kitchen.pause("Restored from save — resume when ready");
    } else {
      // A brand-new restaurant: the first shift starts with the tutorial.
      kitchen.startTutorial();
    }
    this.kitchen = kitchen;
    this.lastSavedAt = Date.now();
    log.info("restaurant opened", { room: this.roomId, restaurant: restaurantId, restored: Boolean(checkpoint) });
  }

  private hooks() {
    return {
      toast: (sessionId: string, text: string, tone: Tone = "info") => {
        if (!sessionId) return;
        const c = this.clients.getById(sessionId);
        c?.send(SERVER_MSG.toast, { text, tone } satisfies ToastMessage);
      },
      broadcastToast: (text: string, tone: Tone = "info") => this.broadcast(SERVER_MSG.toast, { text, tone } satisfies ToastMessage),
      requestServe: (req: ServeRequest) => void this.commitServe(req),
      shiftEnded: (summary: ShiftSummary) => void this.recordShift(summary),
    };
  }

  private async commitServe(req: ServeRequest): Promise<void> {
    const kitchen = this.kitchen;
    if (!kitchen || !this.lease) return;
    try {
      const result = await this.deps.store.commitSale({
        lease: this.lease,
        shiftId: req.shiftId,
        orderNumber: req.orderNumber,
        orderKey: req.orderKey,
        priceCents: req.evaluation.priceCents,
        tipCents: req.evaluation.tipCents,
        score: req.evaluation.score,
        feedback: req.evaluation.feedback,
        servedItemIds: req.servedItemIds,
      });
      if (this.disposed) return;
      // Acknowledge only after commit. A duplicate returns the original sale unchanged.
      kitchen.completeServe(req, result.sale.balanceAfterCents);
      this.state.saveStatus = "ok";
      const by = this.state.players.get(req.by)?.name ?? "";
      const msg: ServedMessage = {
        orderNumber: req.orderNumber,
        score: result.sale.score,
        feedback: result.sale.feedback,
        priceCents: result.sale.priceCents,
        tipCents: result.sale.tipCents,
        accepted: true,
        by,
      };
      this.broadcast(SERVER_MSG.served, msg);
    } catch (err) {
      if (this.disposed) return;
      kitchen.abortServe(req);
      if (err instanceof LeaseLostError) return this.onLeaseLost();
      this.state.saveStatus = "unavailable";
      log.error("sale commit failed", { room: this.roomId, err: err as Error });
      this.broadcast(SERVER_MSG.toast, { text: "Couldn't record that sale — the order is still waiting. Try again in a moment.", tone: "warn" } satisfies ToastMessage);
    }
  }

  private async recordShift(summary: ShiftSummary): Promise<void> {
    if (!this.lease) return;
    const msg: SummaryMessage = {
      revenue: summary.revenue,
      costs: summary.costs,
      waste: summary.waste,
      served: summary.served,
      refused: summary.refused,
      profit: summary.revenue - summary.costs - summary.waste,
      balance: this.state.balance,
    };
    this.broadcast(SERVER_MSG.summary, msg);
    try {
      await this.deps.store.recordShiftSummary({
        lease: this.lease,
        shiftId: summary.shiftId,
        revenueCents: summary.revenue,
        costCents: summary.costs,
        wasteCents: summary.waste,
        served: summary.served,
        refused: summary.refused,
      });
    } catch (err) {
      if (err instanceof LeaseLostError) return this.onLeaseLost();
      log.warn("shift summary not saved", { room: this.roomId, err: err as Error });
    }
    await this.checkpoint("shift-end");
  }

  /** Persists transient state. Never blocks the simulation; overlapping saves are skipped. */
  async checkpoint(reason: string): Promise<boolean> {
    const kitchen = this.kitchen;
    if (!kitchen || !this.lease || this.saving) return false;
    this.saving = true;
    try {
      const snapshot = kitchen.snapshot();
      await this.deps.store.saveCheckpoint(this.lease, { schema: 1, savedAt: new Date().toISOString(), snapshot }, kitchen.stockRecord());
      await this.deps.store.renewLease(this.lease, ROOM.leaseTtlMs);
      this.lastSavedAt = Date.now();
      if (this.state.saveStatus !== "ok") this.state.saveStatus = "ok";
      if (this.state.paused && this.state.pauseReason === "Saving unavailable") kitchen.requestResume([...this.sessions.keys()][0] ?? "");
      log.debug("checkpoint saved", { room: this.roomId, reason });
      return true;
    } catch (err) {
      if (err instanceof LeaseLostError) {
        this.onLeaseLost();
        return false;
      }
      this.state.saveStatus = "pending";
      log.warn("checkpoint failed", { room: this.roomId, reason, err: err as Error });
      // Spec §16: if saves cannot keep the promised interval, pause instead of widening the
      // recovery window silently.
      if (Date.now() - this.lastSavedAt > ROOM.checkpointIntervalMs * 2 && !this.state.paused) {
        this.state.saveStatus = "unavailable";
        kitchen.pause("Saving unavailable");
      }
      return false;
    } finally {
      this.saving = false;
    }
  }

  private onLeaseLost(): void {
    log.error("lease lost; closing room", { room: this.roomId, restaurant: this.restaurantId });
    this.lease = null;
    this.broadcast(SERVER_MSG.toast, { text: "This restaurant was opened somewhere else. Closing this room.", tone: "warn" } satisfies ToastMessage);
    this.kitchen?.pause("Closed");
    this.clock.setTimeout(() => void this.disconnect(4409), 500);
  }

  override async onDrop(client: Client): Promise<void> {
    this.kitchen?.setConnected(client.sessionId, false);
    this.afterPresenceChange();
    try {
      this.allowReconnection(client, NET.reconnectGraceSeconds);
    } catch {
      // Room disposing.
    }
  }

  override onReconnect(client: Client): void {
    this.kitchen?.setConnected(client.sessionId, true);
    this.afterPresenceChange();
    const session = this.sessions.get(client.sessionId);
    if (session) session.results.clear();
    client.send(SERVER_MSG.welcome, this.welcomeFor(client.sessionId));
  }

  welcomeFor(sessionId: string): WelcomeMessage {
    return {
      sessionId,
      protocol: PROTOCOL_VERSION,
      restaurantId: this.restaurantId,
      code: this.roomId,
      isOwner: this.sessions.get(sessionId)?.profileId === this.ownerProfileId,
      tickHz: NET.tickHz,
    };
  }

  override onLeave(client: Client): void {
    this.kitchen?.removePlayer(client.sessionId);
    this.sessions.delete(client.sessionId);
    this.afterPresenceChange();
    log.info("player left", { room: this.roomId, session: client.sessionId, players: this.clients.length });
  }

  /**
   * Empty room → stop simulating immediately and persist (spec §13). The room then unloads
   * once reconnect windows expire (autoDispose). Someone returning starts a resume countdown.
   */
  private afterPresenceChange(): void {
    const kitchen = this.kitchen;
    if (!kitchen) return;
    const connected = kitchen.connectedCount();
    if (connected === 0) {
      if (!this.state.paused) kitchen.pause("Kitchen empty");
      void this.checkpoint("empty");
    } else if (this.state.paused && this.state.pauseReason === "Kitchen empty") {
      kitchen.requestResume([...this.sessions.keys()][0] ?? "");
    }
  }

  override async onDispose(): Promise<void> {
    this.disposed = true;
    if (this.counted) RestaurantRoom.activeRooms--;
    if (this.kitchen && this.lease) {
      this.saving = false;
      await this.checkpoint("dispose");
      await this.deps.store.releaseLease(this.lease).catch(() => undefined);
    }
    this.kitchen?.dispose();
    this.pw?.dispose();
    log.info("room unloaded", { room: this.roomId });
  }

  override onBeforeShutdown(): void {
    // Planned restart: save, tell players, then close. Clients rejoin through the owner.
    this.broadcast(SERVER_MSG.toast, { text: "Server restarting for maintenance — your restaurant is being saved.", tone: "warn" } satisfies ToastMessage);
    void this.checkpoint("shutdown").finally(() => void this.disconnect(4100));
  }

  // ---------------------------------------------------------------------------------------
  // Messages

  private allowIntent(client: Client): boolean {
    const s = this.sessions.get(client.sessionId);
    if (!s) return false;
    const now = Date.now();
    s.tokens = Math.min(NET.maxIntentsPerSecond, s.tokens + ((now - s.lastRefill) / 1000) * NET.maxIntentsPerSecond);
    s.lastRefill = now;
    if (s.tokens < 1) return false;
    s.tokens -= 1;
    return true;
  }

  /** Runs a discrete, command-id-carrying intent exactly once and replies with its result. */
  private command(client: Client, cmd: number, run: (k: Kitchen) => IntentResult): void {
    const session = this.sessions.get(client.sessionId);
    const kitchen = this.kitchen;
    if (!session || !kitchen) return;
    const prior = session.results.get(cmd);
    if (prior) {
      client.send(SERVER_MSG.result, prior);
      return;
    }
    let res: IntentResult;
    if (!this.allowIntent(client)) res = { ok: false, reason: "Slow down" };
    else res = run(kitchen);
    const msg: ResultMessage = res.ok ? { cmd, ok: true } : { cmd, ok: false, reason: res.reason };
    session.results.set(cmd, msg);
    if (session.results.size > RESULT_CACHE) session.results.delete(session.results.keys().next().value!);
    client.send(SERVER_MSG.result, msg);
  }

  /** Orders supplies at the office computer: paid through the store, delivered on commit. */
  private async buy(client: Client, cmd: number, key: StockKey, packs: number): Promise<void> {
    const session = this.sessions.get(client.sessionId);
    const kitchen = this.kitchen;
    if (!session || !kitchen) return;
    const prior = session.results.get(cmd);
    if (prior) {
      client.send(SERVER_MSG.result, prior);
      return;
    }
    const reply = (res: IntentResult): void => {
      const msg: ResultMessage = res.ok ? { cmd, ok: true } : { cmd, ok: false, reason: res.reason };
      session.results.set(cmd, msg);
      if (session.results.size > RESULT_CACHE) session.results.delete(session.results.keys().next().value!);
      client.send(SERVER_MSG.result, msg);
    };
    if (!this.allowIntent(client)) return reply({ ok: false, reason: "Slow down" });
    const check = kitchen.checkBuy(client.sessionId, key, packs);
    if (!check.ok) return reply(check);
    if (!this.lease) return reply({ ok: false, reason: "Saving is unavailable — try again in a moment" });
    try {
      const res = await this.deps.store.purchaseStock({
        lease: this.lease,
        // The session id changes on every connection, so a reloaded page can't collide with an old order.
        purchaseKey: `${client.sessionId}:${cmd}`,
        stockKey: key,
        quantity: check.quantity,
        priceCents: check.priceCents,
      });
      if (this.disposed) return;
      if (!res.ok) return reply({ ok: false, reason: res.reason ?? "Couldn't place that order" });
      kitchen.applyPurchase(key, check.quantity, res.balanceCents);
      this.state.saveStatus = "ok";
      const who = this.state.players.get(client.sessionId)?.name ?? "Someone";
      this.broadcast(SERVER_MSG.toast, { text: `${who} ordered ${check.quantity} ${check.label.toLowerCase()} ($${(check.priceCents / 100).toFixed(2)})`, tone: "success" } satisfies ToastMessage);
      reply({ ok: true });
    } catch (err) {
      if (this.disposed) return;
      if (err instanceof LeaseLostError) {
        this.onLeaseLost();
        return;
      }
      log.warn("purchase failed", { room: this.roomId, err: err as Error });
      reply({ ok: false, reason: "Couldn't place that order — try again" });
    }
  }

  private on<S extends z.ZodType>(type: string, schema: S, handler: (client: Client, msg: z.infer<S>) => void): void {
    this.onMessage(type, (client: Client, raw: unknown) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const cmd = (raw as { cmd?: unknown } | null)?.cmd;
        if (typeof cmd === "number") client.send(SERVER_MSG.result, { cmd, ok: false, reason: "Invalid request" } satisfies ResultMessage);
        log.debug("invalid message", { room: this.roomId, type });
        return;
      }
      handler(client, parsed.data);
    });
  }

  private registerMessages(): void {
    // Request/response handshake: a pushed welcome can race the client's handler registration.
    this.onMessage(SERVER_MSG.welcome, (client: Client) => this.welcomeFor(client.sessionId));
    this.on(MSG.input, inputSchema, (client, msg) => this.kitchen?.pushInput(client.sessionId, msg));
    this.on(MSG.grab, grabSchema, (client, msg) =>
      this.command(client, msg.cmd, (k) => ("item" in msg ? k.grabItem(client.sessionId, msg.item, msg.rev) : k.grabFromDispenser(client.sessionId, msg.dispenser))),
    );
    this.on(MSG.place, placeSchema, (client, msg) => this.command(client, msg.cmd, (k) => k.place(client.sessionId, msg.point, msg.onto, msg.yaw)));
    this.on(MSG.drop, cmdOnlySchema, (client, msg) => this.command(client, msg.cmd, (k) => k.drop(client.sessionId)));
    this.on(MSG.setDown, cmdOnlySchema, (client, msg) => this.command(client, msg.cmd, (k) => k.setDown(client.sessionId)));
    this.on(MSG.offer, offerSchema, (client, msg) => this.command(client, msg.cmd, (k) => k.offer(client.sessionId, msg.to)));
    this.on(MSG.spatula, spatulaSchema, (client, msg) => this.command(client, msg.cmd, (k) => k.spatula(client.sessionId, msg.action, msg.item, msg.rev)));
    this.on(MSG.shift, shiftSchema, (client, msg) => this.command(client, msg.cmd, (k) => k.shiftSwitch(client.sessionId, msg.action)));
    this.on(MSG.ring, ringSchema, (client, msg) =>
      this.command(client, msg.cmd, (k) => k.ring(client.sessionId, msg.customer, { recipe: msg.recipe, modifiers: msg.modifiers, drink: msg.drink as DrinkId | "", side: msg.side })),
    );
    this.on(MSG.buy, buySchema, (client, msg) => void this.buy(client, msg.cmd, msg.stock, msg.packs));
    this.on(MSG.tutorial, tutorialSchema, (client, msg) => this.command(client, msg.cmd, (k) => k.tutorial(client.sessionId, msg.action)));
    this.on(MSG.pause, pauseSchema, (client, msg) =>
      this.command(client, msg.cmd, (k) =>
        msg.action === "request" ? k.requestPause(client.sessionId) : msg.action === "resume" ? k.requestResume(client.sessionId) : k.cancelPauseVote(client.sessionId),
      ),
    );
    // Continuous controls: latest value wins, no command id.
    this.on(MSG.knob, knobSchema, (client, msg) => {
      if (this.state.paused) return;
      this.kitchen?.setKnob(client.sessionId, msg.zone, msg.value);
    });
    this.on(MSG.drawer, drawerSchema, (client, msg) => {
      if (this.state.paused) return;
      this.kitchen?.setDrawer(client.sessionId, msg.value);
    });
    this.on(MSG.squeeze, squeezeSchema, (client, msg) => {
      const res = this.kitchen?.squeeze(client.sessionId, msg.target, msg.intensity);
      if (res && !res.ok && res.reason.startsWith("Out of")) client.send(SERVER_MSG.toast, { text: res.reason, tone: "warn" } satisfies ToastMessage);
    });
    this.on(MSG.ping, pingSchema, (client, msg) => {
      if (!this.allowIntent(client)) return;
      const name = this.state.players.get(client.sessionId)?.name ?? "";
      this.broadcast(SERVER_MSG.ping, { from: client.sessionId, name, preset: msg.preset, point: msg.point });
    });
    this.on(MSG.away, awaySchema, (client, msg) => this.kitchen?.setAway(client.sessionId, msg.away));
    if (this.deps.config.testHooks) {
      // Automated browser tests only; config refuses this flag in production.
      this.on("debugTeleport", debugTeleportSchema, (client, msg) => this.kitchen?.debugPlacePlayer(client.sessionId, { x: msg.x, y: 0, z: msg.z }, msg.yaw, msg.pitch));
    }
  }
}
